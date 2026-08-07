import type { BehaviorSignal } from '../../source/facts/behavior-skeleton.js';
import {
  behaviorConstructRange,
  behaviorReceipt,
  behaviorSignalsByLine,
  behaviorSkeleton,
  governingBehaviorControlLines,
} from '../../source/facts/behavior-skeleton.js';
import { getSourceFacts } from '../../source/facts/source-facts.js';
import { getSourceLines } from '../../source/primitives/source-text.js';
import type { ScipDatabase } from '../../storage/db.js';
import { findIdentifierLines } from '../../symbols/identifier-index.js';
import { readRuntimeBoundaryObservations } from './runtime-boundary-evidence.js';
import type {
  ExplorationEvidenceSource,
  ExplorationSourceLocation,
  ExplorationTopology,
  ExplorationTopologyEdge,
  ExplorationTopologyNode,
} from './exploration-topology.js';
import { queryAlignedCausalSpineNodeIds } from './exploration-topology.js';

const DEFAULT_MAX_STEPS = 16;
const MAX_ACTIVATION_CONTEXT_DEPTH = 4;

export type ConnectedBehaviorStepRole = 'anchor' | 'connector' | 'junction';

export interface ConnectedBehaviorLine {
  line: number;
  endLine: number;
  depth: number;
  signals: BehaviorSignal[];
  text: string;
  copied: boolean;
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
  const causalSpineNodeIds = queryAlignedCausalSpineNodeIds(
    topology,
    matchedAnchorNodeIds,
    Math.max(0, maxSteps - matchedAnchorNodeIds.length),
    { emittedOnly: true },
  );
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
  const anchorNodeIds = new Set(topology.anchors.flatMap((anchor) => [...anchor.nodeIds, ...anchor.candidateNodeIds]));
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
        explicitFocusLines.length > 0
          ? explicitFocusLines
          : focusLinesForNode(db, node, knownCausalEdges, nodeById, pathEdgeIds, expansiveNodeIds),
        expansiveNodeIds.has(node.id) && explicitFocusLines.length === 0,
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

function behaviorForNode(
  db: ScipDatabase,
  node: ExplorationTopologyNode,
  focusLines: readonly number[],
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
  const connectorSlice =
    inRangeFocusLines.length > 0
      ? focusedConnectorSlice(
          db,
          node,
          range.startLine,
          range.endLine,
          inRangeFocusLines,
          outline,
          includeEffectReceipt,
        )
      : null;
  const exactSourceCharacters = sourceLines.slice(range.startLine, range.endLine + 1).join('\n').length;
  const retainCompleteConstruct =
    (preferCompleteSmallConstruct || node.kind === 'runtime-boundary-participant' || node.anchorIds.length > 0) &&
    exactSourceCharacters <= 3_000;
  if (outline && preferCompleteOutline) return outlineRepresentation(outline);
  if (
    !preferCompleteOutline &&
    connectorSlice &&
    !retainCompleteConstruct &&
    (!outline || connectorSlice.renderedCharacters < outline.outlineCharacters)
  ) {
    return connectorSlice;
  }
  if (outline) return outlineRepresentation(outline);
  const selectedSourceLines = sourceLines.slice(range.startLine, range.endLine + 1);
  const source = selectedSourceLines.join('\n');
  const signalsByLine = behaviorSignalsByLine(db, node.location.file, range.startLine, range.endLine);
  return {
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
  };
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
  const sourceLines = getSourceLines(db, node.location.file);
  const selectedLines = new Set(focusLines);
  const receipt = includeEffectReceipt
    ? behaviorReceipt(db, node.location.file, startLine, endLine, { minimumBodyLines: 0 })
    : null;
  const governingControls =
    outline?.lines.filter(
      (line) =>
        line.text.length <= 500 &&
        line.signals.some((signal) => ['branch', 'loop', 'catch', 'finally'].includes(signal)) &&
        focusLines.some((focusLine) => focusLine >= line.line && focusLine <= line.endLine),
    ) ?? governingBehaviorControlLines(db, node.location.file, startLine, endLine, focusLines);
  for (const line of receipt?.lines ?? []) selectedLines.add(line.line);
  for (const line of governingControls) selectedLines.add(line.line);
  const governedFocusBlocks: Array<{
    focusLine: number;
    governingUse: number;
    lines: NonNullable<typeof outline>['lines'];
  }> = [];
  const behaviorSignals = behaviorSignalsByLine(db, node.location.file, startLine, endLine);
  for (const focusLine of focusLines) {
    const binding = bindingName(sourceLines[focusLine] ?? '');
    if (!binding) continue;
    const uses = findIdentifierLines(db, node.location.file, binding).filter(
      (line) => line > focusLine && line <= endLine,
    );
    const firstUse = uses[0];
    if (firstUse !== undefined) selectedLines.add(firstUse);
    const governingUse = uses.find((line) =>
      (behaviorSignals.get(line) ?? []).some((signal) => signal === 'branch' || signal === 'loop'),
    );
    if (governingUse === undefined) continue;
    selectedLines.add(governingUse);
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
    governedFocusBlocks.push({
      focusLine,
      governingUse,
      lines: governedLines.filter(
        (line) =>
          line.line >= governingLine.line &&
          line.line <= governingLine.endLine &&
          line.text.length <= 500 &&
          line.signals.some((signal) => ['binding', 'branch', 'call', 'mutation'].includes(signal)),
      ),
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
  const facts = getSourceFacts(db, node.location.file);
  const callLines = new Set(facts?.callSites.map((site) => site.line) ?? []);
  const outlineSignalsByLine = behaviorSignals;
  const compressedControlByLine = new Map(
    [...(outline?.lines ?? []), ...governingControls]
      .filter((line) => line.signals.some((signal) => ['branch', 'loop', 'catch', 'finally'].includes(signal)))
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
      const compressedControl = compressedControlByLine.get(line);
      return {
        line,
        endLine: compressedControl?.endLine ?? line,
        depth: compressedControl?.depth ?? 0,
        signals: orderedSignals([
          ...(outlineSignalsByLine.get(line) ?? []),
          ...(outline?.lines
            .filter((candidate) => line >= candidate.line && line <= candidate.endLine)
            .flatMap((candidate) => candidate.signals) ?? []),
          ...(receiptSignalsByLine.get(line) ?? []),
          ...(focusLines.includes(line) ? (['anchor'] as const) : []),
          ...(callLines.has(line) ? (['call'] as const) : []),
        ]),
        // A connector slice normally preserves exact source lines. A
        // multiline control header is the exception: copying only its first
        // physical line produces `if (` and loses the predicate that governs
        // the selected effect. The parser-derived outline is a source-faithful
        // single-line encoding of that complete header.
        text: compressedControl?.text ?? (sourceLines[line] ?? '').trim(),
        copied: compressedControl?.copied ?? true,
      };
    })
    .filter((line) => line.text.length > 0);
  if (lines.length === 0) return null;
  const receiptStatements =
    receipt?.candidateLines ??
    behaviorReceipt(db, node.location.file, startLine, endLine, { minimumBodyLines: 0 })?.candidateLines ??
    0;
  const sourceStatements = Math.max(outline?.coverage.sourceStatements ?? 0, receiptStatements, lines.length);
  const signature = outline?.signature ?? (sourceLines[startLine] ?? node.label).trim();
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

function bindingName(sourceLine: string): string | null {
  return /\b(?:const|let|var)\s+([\p{L}_$][\p{L}\p{N}_$]*)\s*=/u.exec(sourceLine)?.[1] ?? null;
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
