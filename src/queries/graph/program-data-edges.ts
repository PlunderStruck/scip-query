import type { IndexedDefinition } from '../../domain/types.js';
import type { ScipDatabase } from '../../storage/db.js';
import { getDefinitionsForFile } from '../../symbols/definition-catalog.js';
import { resolvedCallSitesForDefinition } from '../../symbols/graph/resolved-call-sites.js';
import { parameterValueFlowAtCall, type CallParameterValueFlow } from '../../symbols/graph/value-flow.js';
import type {
  ExplorationFrontierGroup,
  ExplorationTopologyEdge,
  ExplorationTopologyNode,
} from '../internal/exploration-topology.js';
import type { SystemMapRelation } from './system-map.js';

export interface ProgramDataElements {
  nodes: ExplorationTopologyNode[];
  edges: ExplorationTopologyEdge[];
  frontiers: ExplorationFrontierGroup[];
  blindSpots: string[];
}

/** Project one proved compiler-call parameter flow into repository-independent data edges. */
export function programDataElementsForParameterFlow(flow: CallParameterValueFlow): ProgramDataElements {
  const nodes = new Map<string, ExplorationTopologyNode>();
  const edges = new Map<string, ExplorationTopologyEdge>();
  const frontiers: ExplorationFrontierGroup[] = [];

  for (const transfer of flow.transfers) {
    if (!flow.caller) continue;
    const callerParameter = parameterNode(flow.caller, transfer.callerPosition);
    const calleeParameter = parameterNode(flow.callee, transfer.calleePosition);
    addNode(nodes, callerParameter);
    addNode(nodes, calleeParameter);
    addParameterOwnerEdge(edges, flow.caller, callerParameter);
    addParameterOwnerEdge(edges, flow.callee, calleeParameter);
    const edgeId = id(
      'edge',
      'data-transfer',
      transfer.proof.file,
      String(transfer.proof.startLine),
      String(transfer.callerPosition),
      String(transfer.calleePosition),
    );
    edges.set(edgeId, {
      id: edgeId,
      kind: 'data-transfer',
      fromNodeId: callerParameter.id,
      toNodeId: calleeParameter.id,
      directed: true,
      disposition: 'folded',
      semantics: [
        {
          family: 'data',
          subtype: 'argument-to-parameter',
          attributes: {
            argumentText: transfer.argumentText,
            callerPosition: transfer.callerPosition,
            calleePosition: transfer.calleePosition,
          },
        },
      ],
      evidence: [
        {
          method: 'compiler-callsite-direct-parameter-transfer',
          strength: 'exact',
          identity: `${flow.caller.symbol}:${transfer.callerPosition} -> ${flow.callee.symbol}:${transfer.calleePosition}`,
          location: {
            file: transfer.proof.file,
            line: transfer.proof.startLine,
            endLine: transfer.proof.endLine,
          },
        },
      ],
    });
  }

  flow.unknown.forEach((unknown, index) => {
    const expression = argumentExpressionNode(flow, unknown.calleePosition, unknown.argumentText);
    const calleeParameter = parameterNode(flow.callee, unknown.calleePosition);
    addNode(nodes, expression);
    addNode(nodes, calleeParameter);
    addParameterOwnerEdge(edges, flow.callee, calleeParameter);
    const edgeId = id(
      'edge',
      'data-transfer-unsupported',
      unknown.proof.file,
      String(unknown.proof.startLine),
      String(unknown.calleePosition),
      String(index),
    );
    edges.set(edgeId, {
      id: edgeId,
      kind: 'data-transfer',
      fromNodeId: expression.id,
      toNodeId: calleeParameter.id,
      directed: true,
      disposition: 'unsupported',
      semantics: [
        {
          family: 'data',
          subtype: 'argument-to-parameter',
          attributes: {
            argumentText: unknown.argumentText,
            calleePosition: unknown.calleePosition,
          },
        },
      ],
      evidence: [
        {
          method: 'compiler-callsite-argument-expression',
          strength: 'exact',
          identity: unknown.argumentText,
          location: {
            file: unknown.proof.file,
            line: unknown.proof.startLine,
            endLine: unknown.proof.endLine,
          },
        },
      ],
    });
    frontiers.push({
      id: id('frontier', 'data-transfer', edgeId),
      kind: 'data-transfer',
      direction: 'unresolved',
      fromNodeIds: [expression.id],
      edgeIds: [edgeId],
      memberNodeIds: [calleeParameter.id],
      memberCount: 1,
      disposition: 'unsupported',
      reason: unknown.reason,
      expansion: null,
    });
  });

  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    frontiers,
    blindSpots: [],
  };
}

/** Enrich proved system-map calls without relabeling reference co-occurrence as value flow. */
export function programDataElementsForSystemMapRelations(
  db: ScipDatabase,
  relations: readonly SystemMapRelation[],
): ProgramDataElements {
  const result = emptyElements();
  const definitionCache = new Map<string, IndexedDefinition | null>();
  const seenCallsites = new Set<string>();

  for (const relation of relations) {
    if (relation.kind !== 'call' || !relation.fromSymbol || !relation.toSymbol || relation.line === null) continue;
    const callee = definitionCacheEntry(definitionCache, db, relation.toFile, relation.toSymbol);
    if (!callee) continue;
    const resolved = resolvedCallSitesForDefinition(db, callee);
    const sites = resolved.sites.filter(
      (site) =>
        site.file === relation.fromFile &&
        site.startLine <= relation.line! &&
        site.endLine >= relation.line! &&
        site.caller?.symbol === relation.fromSymbol,
    );
    if (sites.length !== 1) {
      const unresolved = resolved.unresolved.find(
        (site) => site.file === relation.fromFile && site.line === relation.line,
      );
      if (unresolved) {
        result.blindSpots.push(
          `Parameter flow unresolved at ${relation.fromFile}:${relation.line + 1}: ${unresolved.reason}.`,
        );
      }
      continue;
    }
    const site = sites[0]!;
    const callsiteKey = `${site.file}\0${site.callNode.startIndex}\0${site.callNode.endIndex}\0${callee.symbol}`;
    if (seenCallsites.has(callsiteKey)) continue;
    seenCallsites.add(callsiteKey);
    mergeElements(result, programDataElementsForParameterFlow(parameterValueFlowAtCall(db, site)));
  }

  result.blindSpots = [...new Set(result.blindSpots)].sort();
  return result;
}

function emptyElements(): ProgramDataElements {
  return { nodes: [], edges: [], frontiers: [], blindSpots: [] };
}

function mergeElements(target: ProgramDataElements, source: ProgramDataElements): void {
  mergeById(target.nodes, source.nodes);
  mergeById(target.edges, source.edges);
  mergeById(target.frontiers, source.frontiers);
  target.blindSpots.push(...source.blindSpots);
}

function mergeById<T extends { id: string }>(target: T[], source: readonly T[]): void {
  const known = new Set(target.map((item) => item.id));
  for (const item of source) {
    if (known.has(item.id)) continue;
    known.add(item.id);
    target.push(item);
  }
}

function definitionCacheEntry(
  cache: Map<string, IndexedDefinition | null>,
  db: ScipDatabase,
  file: string,
  symbol: string,
): IndexedDefinition | null {
  const key = `${file}\0${symbol}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const definition = getDefinitionsForFile(db, file).find((candidate) => candidate.symbol === symbol) ?? null;
  cache.set(key, definition);
  return definition;
}

function parameterNode(definition: IndexedDefinition, position: number): ExplorationTopologyNode {
  return {
    id: parameterNodeId(definition.symbol, position),
    kind: 'parameter',
    label: `${definition.leaf} parameter ${position}`,
    disposition: 'folded',
    location: { file: definition.relativePath, line: definition.startLine, endLine: definition.endLine },
    anchorIds: [],
    attributes: { ownerSymbol: definition.symbol, position },
  };
}

function argumentExpressionNode(
  flow: CallParameterValueFlow,
  calleePosition: number,
  argumentText: string,
): ExplorationTopologyNode {
  return {
    id: id(
      'argument-expression',
      flow.call.file,
      String(flow.call.startLine),
      String(flow.call.endLine),
      String(calleePosition),
    ),
    kind: 'argument-expression',
    label: argumentText,
    disposition: 'unsupported',
    location: { file: flow.call.file, line: flow.call.startLine, endLine: flow.call.endLine },
    anchorIds: [],
    attributes: { calleeSymbol: flow.callee.symbol, position: calleePosition },
  };
}

function addNode(nodes: Map<string, ExplorationTopologyNode>, node: ExplorationTopologyNode): void {
  if (!nodes.has(node.id)) nodes.set(node.id, node);
}

function addParameterOwnerEdge(
  edges: Map<string, ExplorationTopologyEdge>,
  owner: IndexedDefinition,
  parameter: ExplorationTopologyNode,
): void {
  const edgeId = id('edge', 'parameter-owner', owner.symbol, parameter.id);
  if (edges.has(edgeId)) return;
  edges.set(edgeId, {
    id: edgeId,
    kind: 'parameter-owner',
    fromNodeId: symbolNodeId(owner.symbol),
    toNodeId: parameter.id,
    directed: true,
    disposition: 'folded',
    semantics: [{ family: 'identity', subtype: 'contains' }],
    evidence: [
      {
        method: 'compiler-parameter-owner',
        strength: 'exact',
        identity: owner.symbol,
        location: { file: owner.relativePath, line: owner.startLine, endLine: owner.endLine },
      },
    ],
  });
}

function parameterNodeId(symbol: string, position: number): string {
  return id('parameter', symbol, String(position));
}

function symbolNodeId(symbol: string): string {
  return id('symbol', symbol);
}

function id(...parts: readonly string[]): string {
  return parts.map((part) => encodeURIComponent(part)).join(':');
}
