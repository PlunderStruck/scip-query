import type { BehaviorSignal } from '../../source/facts/behavior-skeleton.js';
import { behaviorConstructRange, behaviorReceipt, behaviorSkeleton } from '../../source/facts/behavior-skeleton.js';
import { getSourceFacts } from '../../source/facts/source-facts.js';
import { getSourceLines } from '../../source/primitives/source-text.js';
import type { ScipDatabase } from '../../storage/db.js';
import { findIdentifierLines } from '../../symbols/identifier-index.js';
import { readRuntimeBoundaryObservations } from './runtime-boundary-evidence.js';
import type {
  ExplorationEvidenceSource,
  ExplorationTopology,
  ExplorationTopologyEdge,
  ExplorationTopologyNode,
} from './exploration-topology.js';

const DEFAULT_MAX_STEPS = 12;

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
  };
  behaviorCommand: string | null;
  exactSourceCommand: string | null;
}

export interface ConnectedBehaviorOptions {
  /** Soft limit: matched anchors and nodes on an anchor-connector path are never omitted. */
  maxSteps?: number;
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
  const edgeById = new Map(topology.edges.map((edge) => [edge.id, edge]));
  const pathNodeIds = orderedUnique(topology.paths.flatMap((path) => path.nodeIds));
  const matchedAnchorNodeIds = orderedUnique(
    topology.anchors.filter((anchor) => anchor.status === 'matched').flatMap((anchor) => anchor.nodeIds),
  );
  const requiredNodeIds = new Set([...pathNodeIds, ...matchedAnchorNodeIds]);
  const emittedCausalEdges = topology.edges.filter(
    (edge) => edge.disposition === 'emitted' && edge.kind !== 'structural-membership',
  );
  const knownCausalEdges = topology.edges.filter(
    (edge) =>
      edge.disposition !== 'excluded' && edge.disposition !== 'unsupported' && edge.kind !== 'structural-membership',
  );
  const pathEdgeIds = new Set(topology.paths.flatMap((path) => path.edgeIds));
  const expansiveNodeIds = new Set<string>();
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
  const supplementalNodeIds = new Set(
    emittedCausalEdges
      .filter((edge) => edge.kind === 'call' && expansiveNodeIds.has(edge.fromNodeId))
      .map((edge) => edge.toNodeId),
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
    ...pathNodeIds,
    ...matchedAnchorNodeIds,
    ...supplementalNodeIds,
    ...adjacentNodeIds,
    ...remainingEmittedNodeIds,
  ]).filter((id) => nodeById.has(id));
  const hasConnectorPath = topology.paths.some((path) => path.nodeIds.length > 0);
  const selectedNodeIds: string[] = [];
  for (const nodeId of candidateNodeIds) {
    if (hasConnectorPath && !requiredNodeIds.has(nodeId) && !supplementalNodeIds.has(nodeId)) continue;
    if (selectedNodeIds.length >= maxSteps && !requiredNodeIds.has(nodeId)) continue;
    selectedNodeIds.push(nodeId);
  }
  const selectedNodeIdSet = new Set(selectedNodeIds);
  const stepIdByNode = new Map(selectedNodeIds.map((nodeId) => [nodeId, connectedStepId(nodeId)]));
  const connectorNodeIds = new Set(pathNodeIds);
  const anchorNodeIds = new Set(topology.anchors.flatMap((anchor) => [...anchor.nodeIds, ...anchor.candidateNodeIds]));
  const steps = selectedNodeIds.map((nodeId, order): ConnectedBehaviorStep => {
    const node = nodeById.get(nodeId)!;
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
        focusLinesForNode(db, node, knownCausalEdges, nodeById, pathEdgeIds, expansiveNodeIds),
        expansiveNodeIds.has(node.id),
        supplementalNodeIds.has(node.id),
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
  const transitionEdges = emittedCausalEdges
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
): ConnectedBehaviorRepresentation | null {
  if (!node.location || node.kind !== 'symbol') return null;
  const endLine = node.location.endLine ?? node.location.line;
  const range = behaviorConstructRange(db, node.location.file, node.location.line, endLine, [node.location.line]);
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
  const exactSourceCharacters = getSourceLines(db, node.location.file)
    .slice(range.startLine, range.endLine + 1)
    .join('\n').length;
  const retainCompleteConstruct = preferCompleteSmallConstruct && exactSourceCharacters <= 3_000;
  if (
    connectorSlice &&
    !retainCompleteConstruct &&
    (!outline || connectorSlice.renderedCharacters < outline.outlineCharacters)
  ) {
    return connectorSlice;
  }
  if (outline) {
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
  const sourceLines = getSourceLines(db, node.location.file).slice(range.startLine, range.endLine + 1);
  const source = sourceLines.join('\n');
  return {
    kind: 'source',
    constructKind: 'source construct',
    signature: sourceLines.find((line) => line.trim().length > 0)?.trim() ?? node.label,
    lines: sourceLines.map((text, offset) => ({
      line: range.startLine + offset,
      endLine: range.startLine + offset,
      depth: 0,
      signals: [],
      text,
      copied: true,
    })),
    coverage: {
      sourceStatements: sourceLines.length,
      representedStatements: sourceLines.length,
      copiedStatements: sourceLines.length,
      omittedStatements: 0,
    },
    rawCharacters: source.length,
    renderedCharacters: source.length,
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
  if (!node.location || node.kind !== 'symbol') return [];
  const lines = new Set<number>();
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
    const isExpansiveOutgoingCall =
      expansiveNodeIds.has(node.id) && edge.kind === 'call' && edge.fromNodeId === node.id;
    if (!pathEdgeIds.has(edge.id) && !isExpansiveOutgoingCall) continue;
    for (const source of edge.evidence) {
      if (source.location?.file === node.location.file) lines.add(source.location.line);
    }
    const otherNode = nodeById.get(edge.fromNodeId === node.id ? edge.toNodeId : edge.fromNodeId);
    const leaf = otherNode?.attributes['leaf'];
    if (typeof leaf !== 'string' || leaf.length === 0) continue;
    const firstLine = findIdentifierLines(db, node.location.file, leaf).find(
      (line) => line >= node.location!.line && line <= (node.location!.endLine ?? node.location!.line),
    );
    if (firstLine !== undefined) lines.add(firstLine);
  }
  return [...lines].sort((left, right) => left - right);
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
  for (const line of receipt?.lines ?? []) selectedLines.add(line.line);
  for (const line of outline?.lines ?? []) {
    const governsFocus =
      line.text.length <= 500 &&
      line.signals.some((signal) => ['branch', 'loop', 'catch', 'finally'].includes(signal)) &&
      focusLines.some((focusLine) => focusLine >= line.line && focusLine <= line.endLine);
    if (governsFocus) selectedLines.add(line.line);
  }
  for (const focusLine of focusLines) {
    const binding = bindingName(sourceLines[focusLine] ?? '');
    if (!binding) continue;
    const uses = findIdentifierLines(db, node.location.file, binding).filter(
      (line) => line > focusLine && line <= endLine,
    );
    const firstUse = uses[0];
    if (firstUse !== undefined) selectedLines.add(firstUse);
    const governingUse = uses.find((line) =>
      (outline?.lines ?? []).some(
        (candidate) =>
          candidate.line === line && candidate.signals.some((signal) => signal === 'branch' || signal === 'loop'),
      ),
    );
    if (governingUse === undefined) continue;
    selectedLines.add(governingUse);
    const governingLine = (outline?.lines ?? []).find((line) => line.line === governingUse);
    if (!governingLine) continue;
    for (const line of outline?.lines ?? []) {
      if (line.line < governingLine.line || line.line > governingLine.endLine || line.text.length > 500) continue;
      if (!line.signals.some((signal) => ['binding', 'branch', 'call', 'mutation'].includes(signal))) continue;
      selectedLines.add(line.line);
      if (selectedLines.size >= focusLines.length + 14) break;
    }
  }
  const facts = getSourceFacts(db, node.location.file);
  const callLines = new Set(facts?.callSites.map((site) => site.line) ?? []);
  const outlineSignalsByLine = new Map((outline?.lines ?? []).map((line) => [line.line, line.signals] as const));
  const receiptSignalsByLine = new Map(
    (receipt?.lines ?? []).map(
      (line) => [line.line, line.signals.filter((signal): signal is BehaviorSignal => signal !== 'lifecycle')] as const,
    ),
  );
  const lines = [...selectedLines]
    .filter((line) => line >= startLine && line <= endLine)
    .sort((left, right) => left - right)
    .map(
      (line): ConnectedBehaviorLine => ({
        line,
        endLine: line,
        depth: 0,
        signals: orderedSignals([
          ...(outlineSignalsByLine.get(line) ?? []),
          ...(receiptSignalsByLine.get(line) ?? []),
          ...(focusLines.includes(line) ? (['anchor'] as const) : []),
          ...(callLines.has(line) ? (['call'] as const) : []),
        ]),
        text: (sourceLines[line] ?? '').trim(),
        copied: true,
      }),
    )
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
