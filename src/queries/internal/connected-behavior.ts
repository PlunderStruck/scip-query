import { analyzeSourceFunctions } from '../../source/ast/function-metrics.js';
import { lexicalBindingReferences, type LexicalBindingReference } from '../../source/ast/maintenance-bindings.js';
import type { BehaviorSignal } from '../../source/facts/behavior-skeleton.js';
import {
  behaviorConstructRange,
  behaviorReceipt,
  behaviorSignalsByLine,
  behaviorSkeleton,
  governingBehaviorControlLines,
} from '../../source/facts/behavior-skeleton.js';
import { getAst } from '../../source/ast/ast-core.js';
import type { SyntaxNode } from '../../source/ast/ast-types.js';
import { getSourceFacts } from '../../source/facts/source-facts.js';
import { getSourceLines } from '../../source/primitives/source-text.js';
import type { ScipDatabase } from '../../storage/db.js';
import {
  scipDefinitionSourceConfirmsCallable,
  scipOccurrenceDefinitionTargetsForRange,
} from '../../symbols/graph/scip-occurrence-call-targets.js';
import { findIdentifierLines } from '../../symbols/identifier-index.js';
import { readRuntimeBoundaryObservations } from './runtime-boundary-evidence.js';
import type {
  ExplorationEvidenceSource,
  ExplorationSourceLocation,
  ExplorationTopology,
  ExplorationTopologyEdge,
  ExplorationTopologyNode,
} from './exploration-topology.js';

const DEFAULT_MAX_STEPS = 16;
const MAX_ACTIVATION_CONTEXT_DEPTH = 4;
export const COMPLETE_ANCHOR_SOURCE_CHARACTER_LIMIT = 3_000;
const MAX_CAUSAL_SLICE_MATERIAL_LINE_CHARACTERS = 800;
const SUPPORTING_DECLARATION_NODE_TYPES = new Set([
  'assignment',
  'const_declaration',
  'const_item',
  'field_declaration',
  'lexical_declaration',
  'local_declaration_statement',
  'local_variable_declaration',
  'static_item',
  'variable_declaration',
]);

export type ConnectedBehaviorStepRole = 'anchor' | 'connector' | 'junction';

export interface ConnectedBehaviorLine {
  line: number;
  endLine: number;
  depth: number;
  signals: BehaviorSignal[];
  text: string;
  copied: boolean;
}

export interface ConnectedBehaviorSupportingDeclaration {
  kind: 'compiler-referenced-declaration' | 'focused-causal-target' | 'return-value-transformer';
  symbol: string;
  label: string;
  file: string;
  line: number;
  endLine: number;
  text: string;
}

/**
 * One source-faithful description of a selected construct. An outline accounts
 * for every source statement; exact source is used when outlining would not
 * save characters or the installed parser cannot build a faithful outline.
 */
export interface ConnectedBehaviorRepresentation {
  kind: 'connector-slice' | 'outline' | 'source';
  constructKind: string;
  signature: string;
  lines: ConnectedBehaviorLine[];
  coverage: {
    sourceStatements: number;
    representedStatements: number;
    copiedStatements: number;
    omittedStatements: number;
  };
  rawCharacters: number;
  renderedCharacters: number;
  supportingDeclarations?: ConnectedBehaviorSupportingDeclaration[];
  omittedSupportingDeclarations?: Array<
    Omit<ConnectedBehaviorSupportingDeclaration, 'kind' | 'text'> & { reason: 'source-too-large' }
  >;
}

/** One selected repository construct or non-source junction in connector order. */
export interface ConnectedBehaviorStep {
  id: string;
  nodeId: string;
  order: number;
  role: ConnectedBehaviorStepRole;
  kind: string;
  label: string;
  location: ExplorationTopologyNode['location'];
  behavior: ConnectedBehaviorRepresentation | null;
}

/** One original directed graph edge connecting two returned behavior steps. */
export interface ConnectedBehaviorTransition {
  id: string;
  edgeId: string;
  order: number;
  kind: string;
  fromStepId: string;
  toStepId: string;
  directed: true;
  pathTraversal: 'forward' | 'reverse' | 'adjacent';
  evidence: ExplorationEvidenceSource[];
}

export interface ConnectedBehaviorPath {
  id: string;
  status: 'connected' | 'partial' | 'candidate';
  stepIds: string[];
  transitionIds: string[];
}

/**
 * A connected behavior packet is a graph-ordered source explanation: selected
 * constructs plus the exact relationships that make them one explored slice.
 */
export interface ConnectedBehaviorPacket {
  status: 'connected' | 'partial' | 'ambiguous' | 'unavailable';
  steps: ConnectedBehaviorStep[];
  transitions: ConnectedBehaviorTransition[];
  paths: ConnectedBehaviorPath[];
  coverage: {
    candidateNodes: number;
    returnedNodes: number;
    omittedNodeIds: string[];
    returnedTransitions: number;
    withheldStatements: number;
    requestedFocusLocations: ExplorationSourceLocation[];
    matchedFocusLocations: ExplorationSourceLocation[];
    unmatchedFocusLocations: ExplorationSourceLocation[];
  };
  behaviorCommand: string | null;
  exactSourceCommand: string | null;
}

export interface ConnectedBehaviorOptions {
  /** Soft limit: matched anchors and nodes on an anchor-connector path are never omitted. */
  maxSteps?: number;
  /** Exact source locations that should focus behavior inside otherwise-large selected constructs. */
  focusLocations?: readonly ExplorationSourceLocation[];
}

/** Build one graph-ordered behavior packet from an already selected topology. */
export function connectedBehaviorPacket(
  db: ScipDatabase,
  topology: ExplorationTopology,
  options: ConnectedBehaviorOptions = {},
): ConnectedBehaviorPacket {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  if (!Number.isSafeInteger(maxSteps) || maxSteps <= 0) {
    throw new RangeError(`maxSteps must be a positive safe integer; received ${maxSteps}`);
  }

  const nodeById = new Map(topology.nodes.map((node) => [node.id, node]));
  const requestedFocusLocations = orderedFocusLocations(options.focusLocations ?? []);
  const matchedFocusLocations = new Set<string>();
  const edgeById = new Map(topology.edges.map((edge) => [edge.id, edge]));
  const pathNodeIds = orderedUnique(topology.paths.flatMap((path) => path.nodeIds));
  const matchedAnchorNodeIds = orderedUnique(
    topology.anchors.filter((anchor) => anchor.status === 'matched').flatMap((anchor) => anchor.nodeIds),
  );
  const upstreamCausalNodeIds = topology.nodes
    .filter((node) => node.disposition === 'emitted' && node.attributes['upstreamCausalPath'] === true)
    .sort(
      (left, right) =>
        Number(right.attributes['upstreamCausalDistance'] ?? 0) -
          Number(left.attributes['upstreamCausalDistance'] ?? 0) || left.id.localeCompare(right.id),
    )
    .map((node) => node.id);
  const upstreamCausalNodeIdSet = new Set(upstreamCausalNodeIds);
  const additionalNodeBudget = Math.max(0, maxSteps - matchedAnchorNodeIds.length);
  const focusedCausalNodeIds = focusAlignedCausalTargetNodeIds(
    topology,
    matchedAnchorNodeIds,
    requestedFocusLocations,
    additionalNodeBudget,
  );
  const causalSpineNodeIds = focusedCausalNodeIds.slice(0, additionalNodeBudget);
  const causalSpineNodeIdSet = new Set(causalSpineNodeIds);
  const completeOutlineNodeIds = new Set(causalSpineNodeIds);
  const requiredNodeIds = new Set([...pathNodeIds, ...upstreamCausalNodeIds, ...matchedAnchorNodeIds]);
  const emittedCausalEdges = topology.edges.filter(
    (edge) => edge.disposition === 'emitted' && edge.kind !== 'structural-membership',
  );
  const knownCausalEdges = topology.edges.filter(
    (edge) =>
      edge.disposition !== 'excluded' && edge.disposition !== 'unsupported' && edge.kind !== 'structural-membership',
  );
  const pathEdgeIds = new Set([
    ...topology.paths.flatMap((path) => path.edgeIds),
    ...emittedCausalEdges
      .filter((edge) => upstreamCausalNodeIdSet.has(edge.fromNodeId) && upstreamCausalNodeIdSet.has(edge.toNodeId))
      .map((edge) => edge.id),
  ]);
  const hasConnectorPath = topology.paths.some((path) => path.edgeIds.length > 0);
  // An explicit anchor owns behavior the caller deliberately selected. Connector
  // direction must not reduce an anchor to only the callsite that happened to
  // place it on the shortest path; otherwise a reverse-traversed anchor loses
  // its own direct effects and control decisions.
  const expansiveNodeIds = new Set<string>(matchedAnchorNodeIds);
  for (const nodeId of causalSpineNodeIds) expansiveNodeIds.add(nodeId);
  for (const path of topology.paths) {
    const firstNodeId = path.nodeIds[0];
    const firstEdge = edgeById.get(path.edgeIds[0] ?? '');
    const secondNodeId = path.nodeIds[1];
    if (firstNodeId && secondNodeId && firstEdge?.fromNodeId === firstNodeId && firstEdge.toNodeId === secondNodeId) {
      expansiveNodeIds.add(firstNodeId);
    }
  }
  if (topology.paths.every((path) => path.nodeIds.length === 0)) {
    for (const anchor of topology.anchors) {
      for (const nodeId of anchor.nodeIds) expansiveNodeIds.add(nodeId);
    }
  }
  const upstreamContextNodeIds = mostSpecificCallerSpine(
    matchedAnchorNodeIds,
    knownCausalEdges,
    nodeById,
    MAX_ACTIVATION_CONTEXT_DEPTH,
  );
  const directEffectNodeIds = orderedUnique(
    emittedCausalEdges
      .filter((edge) => edge.kind === 'call' && matchedAnchorNodeIds.includes(edge.fromNodeId))
      .map((edge) => edge.toNodeId),
  );
  // A connector packet already names direct effects in its causal slice. Add
  // the bounded caller spine itself, but leave sibling callee bodies in the
  // recoverable next-anchor manifest: their exact callsites remain visible in
  // the caller skeleton and do not displace entry-to-operation context.
  const supplementalNodeIds = new Set(
    orderedUnique([...upstreamContextNodeIds, ...(hasConnectorPath ? [] : directEffectNodeIds)]),
  );
  for (const nodeId of supplementalNodeIds) expansiveNodeIds.add(nodeId);
  const adjacentNodeIds = orderedUnique(
    emittedCausalEdges.flatMap((edge) =>
      requiredNodeIds.has(edge.fromNodeId) || requiredNodeIds.has(edge.toNodeId)
        ? [edge.fromNodeId, edge.toNodeId]
        : [],
    ),
  );
  const remainingEmittedNodeIds = topology.nodes
    .filter(
      (node) =>
        node.disposition === 'emitted' &&
        node.kind !== 'structural-region' &&
        emittedCausalEdges.some((edge) => edge.fromNodeId === node.id || edge.toNodeId === node.id),
    )
    .map((node) => node.id);
  const candidateNodeIds = orderedUnique([
    ...upstreamCausalNodeIds,
    ...pathNodeIds,
    ...matchedAnchorNodeIds,
    ...causalSpineNodeIds,
    ...supplementalNodeIds,
    ...adjacentNodeIds,
    ...remainingEmittedNodeIds,
  ]).filter((id) => nodeById.has(id));
  const selectedNodeIds: string[] = [];
  for (const nodeId of candidateNodeIds) {
    if (
      hasConnectorPath &&
      !requiredNodeIds.has(nodeId) &&
      !causalSpineNodeIdSet.has(nodeId) &&
      !supplementalNodeIds.has(nodeId)
    ) {
      continue;
    }
    if (selectedNodeIds.length >= maxSteps && !requiredNodeIds.has(nodeId)) continue;
    selectedNodeIds.push(nodeId);
  }
  const selectedNodeIdSet = new Set(selectedNodeIds);
  const stepIdByNode = new Map(selectedNodeIds.map((nodeId) => [nodeId, connectedStepId(nodeId)]));
  const connectorNodeIds = new Set([...pathNodeIds, ...upstreamCausalNodeIds]);
  const anchorNodeIds = new Set(topology.anchors.flatMap((anchor) => anchor.nodeIds));
  const steps = selectedNodeIds.map((nodeId, order): ConnectedBehaviorStep => {
    const node = nodeById.get(nodeId)!;
    const explicitFocusLines = explicitFocusLinesForNode(node, requestedFocusLocations);
    for (const line of explicitFocusLines) matchedFocusLocations.add(focusLocationKey(node.location!.file, line));
    return {
      id: stepIdByNode.get(nodeId)!,
      nodeId,
      order,
      role: anchorNodeIds.has(nodeId) ? 'anchor' : connectorNodeIds.has(nodeId) ? 'connector' : 'junction',
      kind: node.kind,
      label: node.label,
      location: node.location,
      behavior: behaviorForNode(
        db,
        node,
        anchorNodeIds.has(nodeId),
        [
          ...new Set([
            ...explicitFocusLines,
            ...focusLinesForNode(db, node, knownCausalEdges, nodeById, pathEdgeIds, expansiveNodeIds),
          ]),
        ],
        explicitFocusLines,
        expansiveNodeIds.has(node.id) && (explicitFocusLines.length === 0 || anchorNodeIds.has(node.id)),
        supplementalNodeIds.has(node.id),
        completeOutlineNodeIds.has(node.id) && explicitFocusLines.length === 0,
      ),
    };
  });

  const pathTraversalByEdge = new Map<string, 'forward' | 'reverse'>();
  for (const path of topology.paths) {
    for (let index = 0; index < path.edgeIds.length; index += 1) {
      const edge = edgeById.get(path.edgeIds[index]!);
      const fromNodeId = path.nodeIds[index];
      const toNodeId = path.nodeIds[index + 1];
      if (!edge || !fromNodeId || !toNodeId) continue;
      pathTraversalByEdge.set(
        edge.id,
        edge.fromNodeId === fromNodeId && edge.toNodeId === toNodeId ? 'forward' : 'reverse',
      );
    }
  }
  const transitionEdges = knownCausalEdges
    .filter((edge) => selectedNodeIdSet.has(edge.fromNodeId) && selectedNodeIdSet.has(edge.toNodeId))
    .sort((left, right) => compareTransitionEdges(left, right, topology));
  const transitions = transitionEdges.map(
    (edge, order): ConnectedBehaviorTransition => ({
      id: connectedTransitionId(edge.id),
      edgeId: edge.id,
      order,
      kind: edge.kind,
      fromStepId: stepIdByNode.get(edge.fromNodeId)!,
      toStepId: stepIdByNode.get(edge.toNodeId)!,
      directed: true,
      pathTraversal: pathTraversalByEdge.get(edge.id) ?? 'adjacent',
      evidence: edge.evidence,
    }),
  );
  const transitionIdByEdge = new Map(transitions.map((transition) => [transition.edgeId, transition.id]));
  const paths = topology.paths.map(
    (path): ConnectedBehaviorPath => ({
      id: path.id,
      status: path.status,
      stepIds: path.nodeIds.flatMap((nodeId) => {
        const stepId = stepIdByNode.get(nodeId);
        return stepId ? [stepId] : [];
      }),
      transitionIds: path.edgeIds.flatMap((edgeId) => {
        const transitionId = transitionIdByEdge.get(edgeId);
        return transitionId ? [transitionId] : [];
      }),
    }),
  );
  const locations = steps.flatMap((step) => (step.location ? [`${step.location.file}:${step.location.line + 1}`] : []));
  const ambiguous = topology.anchors.some((anchor) => anchor.status === 'ambiguous');
  const connected = paths.some((path) => path.status === 'connected' || path.status === 'candidate');
  const partial = paths.some((path) => path.status === 'partial');

  return {
    status:
      steps.length === 0
        ? 'unavailable'
        : ambiguous
          ? 'ambiguous'
          : connected && !partial
            ? 'connected'
            : partial
              ? 'partial'
              : 'connected',
    steps,
    transitions,
    paths,
    coverage: {
      candidateNodes: candidateNodeIds.length,
      returnedNodes: selectedNodeIds.length,
      omittedNodeIds: candidateNodeIds.filter((nodeId) => !selectedNodeIdSet.has(nodeId)),
      returnedTransitions: transitions.length,
      withheldStatements: steps.reduce((total, step) => total + (step.behavior?.coverage.omittedStatements ?? 0), 0),
      requestedFocusLocations,
      matchedFocusLocations: requestedFocusLocations.filter((location) =>
        matchedFocusLocations.has(focusLocationKey(location.file, location.line)),
      ),
      unmatchedFocusLocations: requestedFocusLocations.filter(
        (location) => !matchedFocusLocations.has(focusLocationKey(location.file, location.line)),
      ),
    },
    behaviorCommand: inspectionCommand(locations, 'behavior'),
    exactSourceCommand: inspectionCommand(locations, 'source'),
  };
}

function focusAlignedCausalTargetNodeIds(
  topology: ExplorationTopology,
  anchorNodeIds: readonly string[],
  focusLocations: readonly ExplorationSourceLocation[],
  limit: number,
): string[] {
  if (limit <= 0 || focusLocations.length === 0) return [];
  const anchors = new Set(anchorNodeIds);
  const focusKeys = new Set(focusLocations.map((location) => focusLocationKey(location.file, location.line)));
  return orderedUnique(
    topology.edges
      .filter(
        (edge) =>
          edge.disposition !== 'excluded' &&
          edge.disposition !== 'unsupported' &&
          ['call', 'runtime-boundary'].includes(edge.kind) &&
          anchors.has(edge.fromNodeId) &&
          edge.evidence.some(
            (evidence) =>
              !['candidate', 'unknown'].includes(evidence.strength) &&
              evidence.location &&
              focusKeys.has(focusLocationKey(evidence.location.file, evidence.location.line)),
          ),
      )
      .sort((left, right) => {
        const leftLocation = left.evidence.find((evidence) => evidence.location)?.location;
        const rightLocation = right.evidence.find((evidence) => evidence.location)?.location;
        return (
          (leftLocation?.file ?? '').localeCompare(rightLocation?.file ?? '') ||
          (leftLocation?.line ?? Number.MAX_SAFE_INTEGER) - (rightLocation?.line ?? Number.MAX_SAFE_INTEGER) ||
          left.id.localeCompare(right.id)
        );
      })
      .map((edge) => edge.toNodeId),
  ).slice(0, limit);
}

function behaviorForNode(
  db: ScipDatabase,
  node: ExplorationTopologyNode,
  preserveCompleteAnchorBehavior: boolean,
  focusLines: readonly number[],
  explicitCausalTargetLines: readonly number[],
  includeEffectReceipt: boolean,
  preferCompleteSmallConstruct: boolean,
  preferCompleteOutline: boolean,
): ConnectedBehaviorRepresentation | null {
  if (!node.location || !['symbol', 'source-construct', 'runtime-boundary-participant'].includes(node.kind))
    return null;
  const endLine = node.location.endLine ?? node.location.line;
  const sourceLines = getSourceLines(db, node.location.file);
  const rangeFocusLines = focusLines.length > 0 ? focusLines : [node.location.line];
  // A boundary observation often identifies one discriminator line inside an
  // object-property handler that has no SCIP symbol. Search the enclosing file
  // for the smallest callable around that exact line, while ordinary symbol
  // nodes stay bounded by their compiler-owned range.
  const range =
    node.kind === 'runtime-boundary-participant'
      ? behaviorConstructRange(db, node.location.file, 0, Math.max(0, sourceLines.length - 1), [node.location.line])
      : behaviorConstructRange(db, node.location.file, node.location.line, endLine, rangeFocusLines);
  const inRangeFocusLines = focusLines.filter((line) => line >= range.startLine && line <= range.endLine);
  const outline = behaviorSkeleton(db, node.location.file, range.startLine, range.endLine, inRangeFocusLines);
  const causalOutline =
    outline ??
    (inRangeFocusLines.length > 0
      ? behaviorSkeleton(db, node.location.file, range.startLine, range.endLine, inRangeFocusLines, {
          requireSavings: false,
        })
      : null);
  const connectorSlice =
    inRangeFocusLines.length > 0
      ? focusedConnectorSlice(
          db,
          node,
          range.startLine,
          range.endLine,
          inRangeFocusLines,
          causalOutline,
          includeEffectReceipt,
        )
      : null;
  const exactSourceCharacters = sourceLines.slice(range.startLine, range.endLine + 1).join('\n').length;
  const rangeSignals = behaviorSignalsByLine(db, node.location.file, range.startLine, range.endLine);
  const hasOversizedMaterialLine = sourceLines
    .slice(range.startLine, range.endLine + 1)
    .some(
      (text, offset) =>
        text.length > MAX_CAUSAL_SLICE_MATERIAL_LINE_CHARACTERS &&
        (rangeSignals.get(range.startLine + offset) ?? []).some((signal) =>
          ['binding', 'branch', 'loop', 'call', 'return', 'throw', 'mutation'].includes(signal),
        ),
    );
  const withSupport = (representation: ConnectedBehaviorRepresentation): ConnectedBehaviorRepresentation =>
    withCompilerReferencedSupportingDeclarations(
      db,
      node,
      range.startLine,
      range.endLine,
      explicitCausalTargetLines.filter((line) => line >= range.startLine && line <= range.endLine),
      representation,
    );
  const retainCompleteConstruct =
    (preferCompleteSmallConstruct || node.kind === 'runtime-boundary-participant' || node.anchorIds.length > 0) &&
    exactSourceCharacters <= COMPLETE_ANCHOR_SOURCE_CHARACTER_LIMIT;
  // Small anchors remain complete. A source-large anchor with explicit causal
  // focus uses the closed connector slice below; that slice must retain the
  // governing predicates and sibling outcomes while omitting unrelated regions.
  const retainCompleteAnchorBehavior =
    preserveCompleteAnchorBehavior && (inRangeFocusLines.length === 0 || retainCompleteConstruct);
  if (outline && (preferCompleteOutline || retainCompleteAnchorBehavior)) {
    return withSupport(outlineRepresentation(outline));
  }
  if (
    !preferCompleteOutline &&
    !retainCompleteAnchorBehavior &&
    connectorSlice &&
    !hasOversizedMaterialLine &&
    !retainCompleteConstruct &&
    connectorSlice.renderedCharacters < (causalOutline?.outlineCharacters ?? exactSourceCharacters)
  ) {
    return withSupport(connectorSlice);
  }
  if (outline) return withSupport(outlineRepresentation(outline));
  const selectedSourceLines = sourceLines.slice(range.startLine, range.endLine + 1);
  const source = selectedSourceLines.join('\n');
  const signalsByLine = behaviorSignalsByLine(db, node.location.file, range.startLine, range.endLine);
  return withSupport({
    kind: 'source',
    constructKind: 'source construct',
    signature: selectedSourceLines.find((line) => line.trim().length > 0)?.trim() ?? node.label,
    lines: selectedSourceLines.map((text, offset) => ({
      line: range.startLine + offset,
      endLine: range.startLine + offset,
      depth: 0,
      signals: signalsByLine.get(range.startLine + offset) ?? [],
      text,
      copied: true,
    })),
    coverage: {
      sourceStatements: selectedSourceLines.length,
      representedStatements: selectedSourceLines.length,
      copiedStatements: selectedSourceLines.length,
      omittedStatements: 0,
    },
    rawCharacters: source.length,
    renderedCharacters: source.length,
  });
}

function withCompilerReferencedSupportingDeclarations(
  db: ScipDatabase,
  node: ExplorationTopologyNode,
  startLine: number,
  endLine: number,
  focusLines: readonly number[],
  representation: ConnectedBehaviorRepresentation,
): ConnectedBehaviorRepresentation {
  if (!node.location) return representation;
  const referenced = scipOccurrenceDefinitionTargetsForRange(db, node.location.file, startLine, endLine);
  if (!referenced.available) return representation;
  const signalsByLine = behaviorSignalsByLine(db, node.location.file, startLine, endLine);
  const causalTargetLines = new Set(focusLines);
  for (const focusLine of focusLines) {
    const firstUse = bindingUsesAfterLine(db, node.location.file, focusLine, endLine)[0];
    if (firstUse !== undefined) causalTargetLines.add(firstUse);
  }
  const directDeclarations = [
    ...new Map(
      referenced.targets.flatMap((target) => {
        const definition = target.definition;
        const overlapsSelectedRange =
          definition.relativePath === node.location!.file &&
          definition.startLine <= endLine &&
          definition.endLine >= startLine;
        if (definition.isTypeLike || overlapsSelectedRange) return [];
        const callable = scipDefinitionSourceConfirmsCallable(db, definition);
        const returnValueTransformer =
          focusLines.length > 0 && callable && signalsByLine.get(target.sourceLine)?.includes('return');
        const focusedCausalTarget = callable && causalTargetLines.has(target.sourceLine);
        if (callable && !returnValueTransformer && !focusedCausalTarget) return [];
        return [
          [
            definition.symbol,
            {
              definition,
              kind: returnValueTransformer
                ? ('return-value-transformer' as const)
                : focusedCausalTarget
                  ? ('focused-causal-target' as const)
                  : ('compiler-referenced-declaration' as const),
            },
          ] as const,
        ];
      }),
    ).values(),
  ].sort(
    (left, right) =>
      left.definition.relativePath.localeCompare(right.definition.relativePath) ||
      left.definition.startLine - right.definition.startLine ||
      left.definition.symbol.localeCompare(right.definition.symbol),
  );
  const nestedDeclarations: Array<(typeof directDeclarations)[number]> = [];
  const nestedQueue = directDeclarations
    .filter(({ kind }) => kind !== 'compiler-referenced-declaration')
    .map(({ definition }) => ({ owner: definition, depth: 1 }));
  const expandedOwnerSymbols = new Set<string>();
  const discoveredDeclarationSymbols = new Set(directDeclarations.map(({ definition }) => definition.symbol));
  while (nestedQueue.length > 0) {
    const next = nestedQueue.shift();
    if (!next || expandedOwnerSymbols.has(next.owner.symbol)) continue;
    expandedOwnerSymbols.add(next.owner.symbol);
    const { owner, depth } = next;
    const nested = scipOccurrenceDefinitionTargetsForRange(db, owner.relativePath, owner.startLine, owner.endLine);
    if (!nested.available) continue;
    const nestedSignals = behaviorSignalsByLine(db, owner.relativePath, owner.startLine, owner.endLine);
    for (const target of nested.targets) {
      const definition = target.definition;
      const overlapsOwner =
        definition.relativePath === owner.relativePath &&
        definition.startLine <= owner.endLine &&
        definition.endLine >= owner.startLine;
      if (definition.isTypeLike || overlapsOwner) continue;
      const callable = scipDefinitionSourceConfirmsCallable(db, definition);
      const boundValueFeedsMaterialPredicate =
        callable &&
        bindingUsesAfterLine(db, owner.relativePath, target.sourceLine, owner.endLine).some((line) =>
          (nestedSignals.get(line) ?? []).some((signal) => ['branch', 'return', 'throw'].includes(signal)),
        );
      const materialPredicateTarget =
        callable &&
        ((nestedSignals.get(target.sourceLine) ?? []).some((signal) =>
          ['branch', 'return', 'throw'].includes(signal),
        ) ||
          boundValueFeedsMaterialPredicate);
      if (callable && !materialPredicateTarget) continue;
      if (!discoveredDeclarationSymbols.has(definition.symbol)) {
        discoveredDeclarationSymbols.add(definition.symbol);
        nestedDeclarations.push({
          definition,
          kind: callable ? 'focused-causal-target' : 'compiler-referenced-declaration',
        });
      }
      // Two compiler-resolved causal hops cover normalization and guard helpers
      // without making declaration count or source order an accidental stopping rule.
      if (callable && depth < 2) nestedQueue.push({ owner: definition, depth: depth + 1 });
    }
  }
  const declarations = [
    ...new Map(
      [...directDeclarations, ...nestedDeclarations].map((declaration) => [declaration.definition.symbol, declaration]),
    ).values(),
  ].sort(
    (left, right) =>
      left.definition.relativePath.localeCompare(right.definition.relativePath) ||
      left.definition.startLine - right.definition.startLine ||
      left.definition.symbol.localeCompare(right.definition.symbol),
  );
  const supportingDeclarations: ConnectedBehaviorSupportingDeclaration[] = [];
  const omittedSupportingDeclarations: NonNullable<ConnectedBehaviorRepresentation['omittedSupportingDeclarations']> =
    [];
  for (const { definition, kind } of declarations) {
    const declarationRange =
      kind === 'compiler-referenced-declaration'
        ? supportingDeclarationRange(db, definition.relativePath, definition.startLine, definition.endLine)
        : { startLine: definition.startLine, endLine: definition.endLine };
    const sourceText = getSourceLines(db, definition.relativePath)
      .slice(declarationRange.startLine, declarationRange.endLine + 1)
      .join('\n');
    const callableOutline =
      kind === 'compiler-referenced-declaration'
        ? null
        : behaviorSkeleton(db, definition.relativePath, definition.startLine, definition.endLine, []);
    const outlineText = callableOutline
      ? [
          callableOutline.signature,
          ...callableOutline.lines.map(
            (line) => `${line.line + 1}${line.signals.length > 0 ? `[${line.signals.join(',')}]` : ''} ${line.text}`,
          ),
        ].join(' | ')
      : null;
    const text = outlineText && outlineText.length < sourceText.length ? outlineText : sourceText;
    const base = {
      symbol: definition.symbol,
      label: definition.leaf,
      file: definition.relativePath,
      line: declarationRange.startLine,
      endLine: declarationRange.endLine,
    };
    const characterLimit = kind === 'compiler-referenced-declaration' ? 1_000 : 8_000;
    const lineLimit = kind === 'compiler-referenced-declaration' ? 12 : 120;
    if (text.length > characterLimit || declarationRange.endLine - declarationRange.startLine > lineLimit) {
      omittedSupportingDeclarations.push({ ...base, reason: 'source-too-large' });
      continue;
    }
    supportingDeclarations.push({ kind, ...base, text });
  }
  return {
    ...representation,
    ...(supportingDeclarations.length === 0 ? {} : { supportingDeclarations }),
    ...(omittedSupportingDeclarations.length === 0 ? {} : { omittedSupportingDeclarations }),
  };
}

function supportingDeclarationRange(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
  endLine: number,
): { startLine: number; endLine: number } {
  const tree = getAst(db, relativePath);
  if (!tree) return { startLine, endLine };
  const candidates: SyntaxNode[] = [];
  walkSyntaxNodes(tree.rootNode, (node) => {
    if (
      SUPPORTING_DECLARATION_NODE_TYPES.has(node.type) &&
      node.startPosition.row <= startLine &&
      node.endPosition.row >= endLine
    ) {
      candidates.push(node);
    }
  });
  const selected = candidates.sort(
    (left, right) =>
      left.endPosition.row - left.startPosition.row - (right.endPosition.row - right.startPosition.row) ||
      left.endIndex - left.startIndex - (right.endIndex - right.startIndex),
  )[0];
  return selected
    ? { startLine: selected.startPosition.row, endLine: selected.endPosition.row }
    : { startLine, endLine };
}

function walkSyntaxNodes(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) walkSyntaxNodes(child, visit);
}

function outlineRepresentation(
  outline: NonNullable<ReturnType<typeof behaviorSkeleton>>,
): ConnectedBehaviorRepresentation {
  return {
    kind: 'outline',
    constructKind: outline.constructKind,
    signature: outline.signature,
    lines: outline.lines,
    coverage: outline.coverage,
    rawCharacters: outline.rawCharacters,
    renderedCharacters: outline.outlineCharacters,
  };
}

function focusLinesForNode(
  db: ScipDatabase,
  node: ExplorationTopologyNode,
  edges: readonly ExplorationTopologyEdge[],
  nodeById: ReadonlyMap<string, ExplorationTopologyNode>,
  pathEdgeIds: ReadonlySet<string>,
  expansiveNodeIds: ReadonlySet<string>,
): number[] {
  if (!node.location || !['symbol', 'source-construct', 'runtime-boundary-participant'].includes(node.kind)) return [];
  const lines = new Set<number>();
  const callLines = new Set(getSourceFacts(db, node.location.file)?.callSites.map((site) => site.line) ?? []);
  if (node.kind === 'runtime-boundary-participant') lines.add(node.location.line);
  if (expansiveNodeIds.has(node.id)) {
    for (const observation of readRuntimeBoundaryObservations(db, { files: [node.location.file] })) {
      if (
        observation.source.startLine >= node.location.line &&
        observation.source.startLine <= (node.location.endLine ?? node.location.line)
      ) {
        lines.add(observation.source.startLine);
      }
    }
  }
  for (const edge of edges) {
    if (edge.fromNodeId !== node.id && edge.toNodeId !== node.id) continue;
    const otherNode = nodeById.get(edge.fromNodeId === node.id ? edge.toNodeId : edge.fromNodeId);
    const isExpansiveOutgoingCausalEdge =
      expansiveNodeIds.has(node.id) &&
      ['call', 'reference', 'runtime-boundary'].includes(edge.kind) &&
      edge.fromNodeId === node.id;
    const touchesExplicitAnchor = (otherNode?.anchorIds.length ?? 0) > 0;
    if (!pathEdgeIds.has(edge.id) && !isExpansiveOutgoingCausalEdge && !touchesExplicitAnchor) continue;
    const evidenceLines = edge.evidence.flatMap((source) =>
      source.location?.file === node.location!.file ? [source.location.line] : [],
    );
    const callsiteEvidenceLines = evidenceLines.filter((line) => callLines.has(line));
    for (const line of callsiteEvidenceLines.length > 0 ? callsiteEvidenceLines : evidenceLines) {
      lines.add(line);
    }
    const leaf = otherNode?.attributes['leaf'];
    if (typeof leaf !== 'string' || leaf.length === 0) continue;
    const identifierLines = findIdentifierLines(db, node.location.file, leaf).filter(
      (line) => line >= node.location!.line && line <= (node.location!.endLine ?? node.location!.line),
    );
    const firstLine = identifierLines.find((line) => callLines.has(line)) ?? identifierLines[0];
    if (firstLine !== undefined) lines.add(firstLine);
  }
  return [...lines].sort((left, right) => left - right);
}

function explicitFocusLinesForNode(
  node: ExplorationTopologyNode,
  locations: readonly ExplorationSourceLocation[],
): number[] {
  if (!node.location) return [];
  const endLine = node.location.endLine ?? node.location.line;
  return locations
    .filter(
      (location) =>
        location.file === node.location!.file && location.line >= node.location!.line && location.line <= endLine,
    )
    .map((location) => location.line);
}

function orderedFocusLocations(locations: readonly ExplorationSourceLocation[]): ExplorationSourceLocation[] {
  const unique = new Map<string, ExplorationSourceLocation>();
  for (const location of locations) {
    if (!location.file || !Number.isSafeInteger(location.line) || location.line < 0) {
      throw new RangeError(
        `Behavior focus locations require a repository file and non-negative line; received ${JSON.stringify(location)}.`,
      );
    }
    unique.set(focusLocationKey(location.file, location.line), { file: location.file, line: location.line });
  }
  return [...unique.values()].sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
}

function focusLocationKey(file: string, line: number): string {
  return `${file}\0${line}`;
}

interface ConnectorSliceSource {
  db: ScipDatabase;
  file: string;
  label: string;
  startLine: number;
  endLine: number;
  focusLines: readonly number[];
  outline: ReturnType<typeof behaviorSkeleton>;
  sourceLines: readonly string[];
  behaviorSignals: Map<number, BehaviorSignal[]>;
}

function connectorGoverningControls(context: ConnectorSliceSource, normalizedFocusLines: readonly number[]) {
  const { db, file, startLine, endLine, outline } = context;
  return outline
    ? [
        ...new Map(
          normalizedFocusLines.flatMap((focusLine) =>
            outline.lines
              .filter(
                (line) =>
                  line.text.length <= 500 &&
                  line.signals.some((signal) => ['branch', 'loop', 'catch', 'finally'].includes(signal)) &&
                  focusLine >= line.line &&
                  focusLine <= line.endLine,
              )
              .sort((left, right) => left.endLine - left.line - (right.endLine - right.line) || left.line - right.line)
              .slice(0, 2)
              .map((line) => [`${line.line}\0${line.endLine}`, line] as const),
          ),
        ).values(),
      ]
    : governingBehaviorControlLines(db, file, startLine, endLine, normalizedFocusLines);
}

function governedBindingStatements(context: ConnectorSliceSource, governingUse: number) {
  const { outline, endLine, sourceLines, behaviorSignals } = context;
  const governingLine = (outline?.lines ?? []).find((line) => line.line === governingUse) ?? {
    line: governingUse,
    endLine: Math.min(endLine, governingUse + 40),
    depth: 0,
    signals: behaviorSignals.get(governingUse) ?? [],
    text: (sourceLines[governingUse] ?? '').trim(),
    copied: true,
  };
  const governedLines =
    outline?.lines ??
    sourceLines.slice(governingLine.line, governingLine.endLine + 1).map((text, offset) => {
      const line = governingLine.line + offset;
      return {
        line,
        endLine: line,
        depth: 0,
        signals: behaviorSignals.get(line) ?? [],
        text: text.trim(),
        copied: true,
      };
    });
  return governedLines.filter(
    (line) =>
      line.line >= governingLine.line &&
      line.line <= governingLine.endLine &&
      line.text.length <= 500 &&
      line.signals.some((signal) => ['binding', 'branch', 'call', 'mutation'].includes(signal)),
  );
}

function addGovernedFocusBindings(
  context: ConnectorSliceSource,
  normalizedFocusLines: readonly number[],
  selectedLines: Set<number>,
): void {
  const { db, file, endLine, behaviorSignals } = context;
  const governedFocusBlocks: Array<{
    focusLine: number;
    governingUse: number;
    lines: NonNullable<ConnectorSliceSource['outline']>['lines'];
  }> = [];
  for (const focusLine of normalizedFocusLines) {
    const uses = bindingUsesAfterLine(db, file, focusLine, endLine);
    const firstUse = uses[0];
    if (firstUse !== undefined) selectedLines.add(firstUse);
    const governingUse = uses.find((line) =>
      (behaviorSignals.get(line) ?? []).some((signal) => signal === 'branch' || signal === 'loop'),
    );
    if (governingUse === undefined) continue;
    selectedLines.add(governingUse);
    governedFocusBlocks.push({
      focusLine,
      governingUse,
      lines: governedBindingStatements(context, governingUse),
    });
  }
  // A call result that survives into a distant control block carries causal
  // state across phases of the construct. Preserve the decisive statements in
  // the longest-lived blocks first; otherwise a large number of nearby call
  // sites can consume the slice budget before the later effect is shown.
  for (const block of governedFocusBlocks
    .sort(
      (left, right) =>
        right.governingUse - right.focusLine - (left.governingUse - left.focusLine) || left.focusLine - right.focusLine,
    )
    .slice(0, 2)) {
    for (const line of block.lines.slice(0, 14)) selectedLines.add(line.line);
  }
}

function addControlBodyStatements(
  outline: ReturnType<typeof behaviorSkeleton>,
  controls: ReturnType<typeof connectorGoverningControls>,
  selectedLines: Set<number>,
  materialSignals: Set<BehaviorSignal>,
): void {
  for (const control of controls) {
    for (const line of outline?.lines ?? []) {
      if (line.line < control.line || line.line > control.endLine) continue;
      if (line.signals.some((signal) => materialSignals.has(signal))) selectedLines.add(line.line);
    }
  }
}

function connectorLineSignals(
  context: ConnectorSliceSource,
  line: number,
  receiptSignalsByLine: Map<number, BehaviorSignal[]>,
  callLines: Set<number>,
): BehaviorSignal[] {
  const { behaviorSignals, outline, focusLines } = context;
  return orderedSignals([
    ...(behaviorSignals.get(line) ?? []),
    ...(outline?.lines
      .filter((candidate) => line >= candidate.line && line <= candidate.endLine)
      .flatMap((candidate) => candidate.signals) ?? []),
    ...(receiptSignalsByLine.get(line) ?? []),
    ...(focusLines.includes(line) ? (['anchor'] as const) : []),
    ...(callLines.has(line) ? (['call'] as const) : []),
  ]);
}

function renderConnectorSlice(
  context: ConnectorSliceSource,
  selectedLines: Set<number>,
  governingControls: ReturnType<typeof connectorGoverningControls>,
  receipt: ReturnType<typeof behaviorReceipt>,
): ConnectedBehaviorRepresentation | null {
  const { db, file, startLine, endLine, outline, sourceLines } = context;
  const facts = getSourceFacts(db, file);
  const callLines = new Set(facts?.callSites.map((site) => site.line) ?? []);
  const compressedControlByLine = new Map(
    [...(outline?.lines ?? []), ...governingControls]
      .filter((line) => line.signals.some((signal) => ['branch', 'loop', 'catch', 'finally'].includes(signal)))
      .map((line) => [line.line, line] as const),
  );
  const compressedStructuredDataByLine = new Map(
    (outline?.lines ?? [])
      .filter(
        (line) =>
          line.text.length <= 500 &&
          line.signals.includes('shape') &&
          (line.signals.includes('call') || line.signals.includes('mutation') || line.signals.includes('return')),
      )
      .sort((left, right) => left.endLine - left.line - (right.endLine - right.line) || left.line - right.line)
      .map((line) => [line.line, line] as const),
  );
  const receiptSignalsByLine = new Map(
    (receipt?.lines ?? []).map(
      (line) => [line.line, line.signals.filter((signal): signal is BehaviorSignal => signal !== 'lifecycle')] as const,
    ),
  );
  const lines = [...selectedLines]
    .filter((line) => line >= startLine && line <= endLine)
    .sort((left, right) => left - right)
    .map((line): ConnectedBehaviorLine => {
      const compressedStatement = compressedControlByLine.get(line) ?? compressedStructuredDataByLine.get(line);
      return {
        line,
        endLine: compressedStatement?.endLine ?? line,
        depth: compressedStatement?.depth ?? 0,
        signals: connectorLineSignals(context, line, receiptSignalsByLine, callLines),
        // A connector slice normally preserves exact source lines. Multiline
        // control headers and structured mutations/returns are exceptions:
        // copying only their first physical line loses either the governing
        // predicate or the exact payload shape. The parser-derived outline
        // preserves the complete statement.
        text: compressedStatement?.text ?? (sourceLines[line] ?? '').trim(),
        copied: compressedStatement?.copied ?? true,
      };
    })
    .filter((line) => line.text.length > 0);
  if (lines.length === 0) return null;
  return connectorSliceRepresentation(context, lines, receipt);
}

function connectorSliceRepresentation(
  context: ConnectorSliceSource,
  lines: ConnectedBehaviorLine[],
  receipt: ReturnType<typeof behaviorReceipt>,
): ConnectedBehaviorRepresentation {
  const { db, file, label, startLine, endLine, outline, sourceLines } = context;
  const receiptStatements =
    receipt?.candidateLines ??
    behaviorReceipt(db, file, startLine, endLine, { minimumBodyLines: 0 })?.candidateLines ??
    0;
  const sourceStatements = Math.max(outline?.coverage.sourceStatements ?? 0, receiptStatements, lines.length);
  const signature = outline?.signature ?? (sourceLines[startLine] ?? label).trim();
  const renderedCharacters =
    signature.length + lines.reduce((total, line) => total + line.text.length + line.signals.join(',').length + 12, 0);
  const rawCharacters = sourceLines.slice(startLine, endLine + 1).join('\n').length;
  return {
    kind: 'connector-slice',
    constructKind: outline?.constructKind ?? 'source construct',
    signature,
    lines,
    coverage: {
      sourceStatements,
      representedStatements: lines.length,
      copiedStatements: lines.length,
      omittedStatements: Math.max(0, sourceStatements - lines.length),
    },
    rawCharacters,
    renderedCharacters,
  };
}

function focusedConnectorSlice(
  db: ScipDatabase,
  node: ExplorationTopologyNode,
  startLine: number,
  endLine: number,
  focusLines: readonly number[],
  outline: ReturnType<typeof behaviorSkeleton>,
  includeEffectReceipt: boolean,
): ConnectedBehaviorRepresentation | null {
  if (!node.location) return null;
  const lexicalBindings = sourceLexicalBindings(db, node.location.file);
  // Without same-binding identity, retain the complete outline/source instead of guessing from spelling.
  if (!lexicalBindings) return null;
  const sourceLines = getSourceLines(db, node.location.file);
  const behaviorSignals = behaviorSignalsByLine(db, node.location.file, startLine, endLine);
  const context: ConnectorSliceSource = {
    db,
    file: node.location.file,
    label: node.label,
    startLine,
    endLine,
    focusLines,
    outline,
    sourceLines,
    behaviorSignals,
  };
  const materialLineNumbers = [...behaviorSignals]
    .filter(([, signals]) => signals.length > 0)
    .map(([line]) => line)
    .sort((left, right) => left - right);
  const normalizedFocusLines = focusLines.map((line) => {
    if ((behaviorSignals.get(line) ?? []).length > 0) return line;
    return materialLineNumbers.find((candidate) => candidate > line && candidate - line <= 8) ?? line;
  });
  const selectedLines = new Set([...focusLines, ...normalizedFocusLines]);
  const receipt = includeEffectReceipt
    ? behaviorReceipt(db, context.file, startLine, endLine, { minimumBodyLines: 0 })
    : null;
  const governingControls = connectorGoverningControls(context, normalizedFocusLines);
  for (const line of receipt?.lines ?? []) selectedLines.add(line.line);
  for (const line of governingControls) selectedLines.add(line.line);
  for (const [line, signals] of behaviorSignals) {
    if (signals.includes('call') && signals.includes('shape')) selectedLines.add(line);
  }
  addGovernedFocusBindings(context, normalizedFocusLines, selectedLines);
  const materialSignals = new Set<BehaviorSignal>(['binding', 'branch', 'loop', 'call', 'return', 'throw', 'mutation']);
  addControlBodyStatements(outline, governingControls, selectedLines, materialSignals);
  expandLexicalBindingClosure(lexicalBindings, selectedLines, behaviorSignals, startLine, endLine, materialSignals);
  const selectedControls = (outline?.lines ?? []).filter(
    (control) =>
      selectedLines.has(control.line) &&
      control.signals.some((signal) => ['branch', 'loop', 'catch', 'finally'].includes(signal)),
  );
  addControlBodyStatements(outline, selectedControls, selectedLines, materialSignals);
  return renderConnectorSlice(context, selectedLines, governingControls, receipt);
}

function orderedSignals(signals: readonly BehaviorSignal[]): BehaviorSignal[] {
  const order: readonly BehaviorSignal[] = [
    'anchor',
    'signature',
    'binding',
    'branch',
    'loop',
    'call',
    'await',
    'return',
    'throw',
    'mutation',
    'shape',
    'spread',
    'catch',
    'finally',
  ];
  const available = new Set(signals);
  return order.filter((signal) => available.has(signal));
}

const LEXICAL_BINDINGS_BY_DB = new WeakMap<
  ScipDatabase,
  Map<string, { source: string; bindings: LexicalBindingReference[] | null }>
>();

function sourceLexicalBindings(db: ScipDatabase, file: string): LexicalBindingReference[] | null {
  const language = getSourceFacts(db, file)?.language;
  if (language !== 'typescript' && language !== 'tsx' && language !== 'javascript') return null;
  const source = getSourceLines(db, file).join('\n');
  let cache = LEXICAL_BINDINGS_BY_DB.get(db);
  if (!cache) {
    cache = new Map();
    LEXICAL_BINDINGS_BY_DB.set(db, cache);
  }
  const cached = cache.get(file);
  if (cached?.source === source) return cached.bindings;
  const analysis = analyzeSourceFunctions(file, source);
  const bindings = analysis.errors.length === 0 ? lexicalBindingReferences(analysis) : null;
  cache.set(file, { source, bindings });
  return bindings;
}

function bindingUsesAfterLine(db: ScipDatabase, file: string, line: number, endLine: number): number[] {
  return [
    ...new Set(
      (sourceLexicalBindings(db, file) ?? [])
        .filter((binding) => binding.startLine <= line && binding.endLine >= line)
        .flatMap((binding) => binding.referenceLines.filter((use) => use > line && use <= endLine)),
    ),
  ].sort((a, b) => a - b);
}

function expandLexicalBindingClosure(
  bindings: readonly LexicalBindingReference[],
  selectedLines: Set<number>,
  signals: Map<number, BehaviorSignal[]>,
  startLine: number,
  endLine: number,
  materialSignals: Set<BehaviorSignal>,
): void {
  const eligible = bindings.filter(
    (binding) =>
      binding.startLine >= startLine &&
      binding.endLine <= endLine &&
      (binding.startLine !== startLine || binding.endLine !== endLine),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const binding of eligible) {
      const touchesSelection =
        binding.referenceLines.some((line) => selectedLines.has(line)) ||
        [...selectedLines].some((line) => line >= binding.startLine && line <= binding.endLine);
      if (!touchesSelection) continue;
      const declarations = Array.from(
        { length: binding.endLine - binding.startLine + 1 },
        (_, i) => binding.startLine + i,
      );
      const references = binding.referenceLines.filter(
        (line) =>
          line >= startLine &&
          line <= endLine &&
          (signals.get(line) ?? []).some((signal) => materialSignals.has(signal)),
      );
      for (const line of [...declarations, ...references]) {
        if (selectedLines.has(line)) continue;
        selectedLines.add(line);
        changed = true;
      }
    }
  }
}

function mostSpecificCallers(
  anchorNodeIds: readonly string[],
  edges: readonly ExplorationTopologyEdge[],
  nodeById: ReadonlyMap<string, ExplorationTopologyNode>,
): string[] {
  return orderedUnique(
    anchorNodeIds.flatMap((anchorNodeId) => {
      const anchorNode = nodeById.get(anchorNodeId);
      const callers = edges
        .filter((edge) => edge.kind === 'call' && edge.toNodeId === anchorNodeId)
        .map((edge) => ({ edge, node: nodeById.get(edge.fromNodeId) }))
        .filter(
          (candidate): candidate is { edge: ExplorationTopologyEdge; node: ExplorationTopologyNode } =>
            candidate.node !== undefined &&
            ['symbol', 'source-construct', 'runtime-boundary-participant'].includes(candidate.node.kind) &&
            candidate.node.location !== null,
        )
        .sort((left, right) => {
          const evidenceDifference = strongestEdgeEvidenceRank(right.edge) - strongestEdgeEvidenceRank(left.edge);
          if (evidenceDifference !== 0) return evidenceDifference;
          const leftLocal = sameRepositoryArea(left.node, anchorNode) ? 0 : 1;
          const rightLocal = sameRepositoryArea(right.node, anchorNode) ? 0 : 1;
          const leftSpan =
            (left.node.location?.endLine ?? left.node.location?.line ?? 0) - (left.node.location?.line ?? 0);
          const rightSpan =
            (right.node.location?.endLine ?? right.node.location?.line ?? 0) - (right.node.location?.line ?? 0);
          return leftLocal - rightLocal || leftSpan - rightSpan || left.node.label.localeCompare(right.node.label);
        });
      return callers[0] ? [callers[0].node.id] : [];
    }),
  );
}

function strongestEdgeEvidenceRank(edge: ExplorationTopologyEdge): number {
  const rank: Record<ExplorationEvidenceSource['strength'], number> = {
    exact: 4,
    mixed: 3,
    derived: 2,
    candidate: 1,
    unknown: 0,
  };
  return Math.max(0, ...edge.evidence.map((evidence) => rank[evidence.strength]));
}

function sameRepositoryArea(left: ExplorationTopologyNode, right: ExplorationTopologyNode | undefined): boolean {
  if (!left.location || !right?.location) return false;
  return repositoryArea(left.location.file) === repositoryArea(right.location.file);
}

function repositoryArea(file: string): string {
  return file.split('/').filter(Boolean).slice(0, 2).join('/');
}

/**
 * Follow the most specific exact caller of each selected construct repeatedly.
 * A single caller identifies only the immediate activation site; the bounded
 * spine exposes the enclosing entry-to-operation chain without expanding all
 * reverse references or guessing which repository-specific entry name matters.
 */
function mostSpecificCallerSpine(
  anchorNodeIds: readonly string[],
  edges: readonly ExplorationTopologyEdge[],
  nodeById: ReadonlyMap<string, ExplorationTopologyNode>,
  maxDepth: number,
): string[] {
  const seedNodeIds = new Set(anchorNodeIds);
  const traversedNodeIds = new Set<string>();
  const result: string[] = [];
  let frontier = orderedUnique(anchorNodeIds);

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const current = frontier.filter((nodeId) => !traversedNodeIds.has(nodeId));
    for (const nodeId of current) traversedNodeIds.add(nodeId);
    const callers = mostSpecificCallers(current, edges, nodeById);
    frontier = [];
    for (const callerNodeId of callers) {
      if (!seedNodeIds.has(callerNodeId) && !result.includes(callerNodeId)) result.push(callerNodeId);
      if (!traversedNodeIds.has(callerNodeId)) frontier.push(callerNodeId);
    }
  }

  return result;
}

function compareTransitionEdges(
  left: ExplorationTopologyEdge,
  right: ExplorationTopologyEdge,
  topology: ExplorationTopology,
): number {
  const pathOrder = new Map(topology.paths.flatMap((path) => path.edgeIds).map((edgeId, index) => [edgeId, index]));
  return (
    (pathOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (pathOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER) ||
    left.id.localeCompare(right.id)
  );
}

function connectedStepId(nodeId: string): string {
  return `step:${nodeId}`;
}

function connectedTransitionId(edgeId: string): string {
  return `transition:${edgeId}`;
}

function inspectionCommand(locations: readonly string[], view: 'behavior' | 'source'): string | null {
  if (locations.length === 0) return null;
  return `scip-query inspect ${locations.map((location) => `--at ${shellArgument(location)}`).join(' ')} --view ${view}`;
}

function shellArgument(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

function orderedUnique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
