import type { IndexedDefinition } from '../../domain/types.js';
import { getAst } from '../../source/ast/ast-core.js';
import type { ScipDatabase } from '../../storage/db.js';
import { getDefinitionsForFile } from '../../symbols/definition-catalog.js';
import { resolvedCallSitesForDefinition } from '../../symbols/graph/resolved-call-sites.js';
import { evaluateStaticValue } from '../../symbols/graph/static-value-flow.js';
import {
  parameterValueFlowAtCall,
  type CallParameterValueFlow,
  type EvaluatedStaticValue,
} from '../../symbols/graph/value-flow.js';
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
export function programDataElementsForParameterFlow(
  flow: CallParameterValueFlow,
  staticArguments: ReadonlyMap<number, EvaluatedStaticValue> = new Map(),
): ProgramDataElements {
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
    const calleeParameter = parameterNode(flow.callee, unknown.calleePosition);
    addNode(nodes, calleeParameter);
    addParameterOwnerEdge(edges, flow.callee, calleeParameter);
    const staticValue = staticArguments.get(unknown.calleePosition);
    if (staticValue && isProvedStaticValue(staticValue)) {
      addStaticValueTransfer(edges, nodes, flow, unknown.calleePosition, unknown.argumentText, staticValue);
      return;
    }
    const expression = argumentExpressionNode(flow, unknown.calleePosition, unknown.argumentText);
    addNode(nodes, expression);
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
      reason: staticValue?.derivation.rule ?? unknown.reason,
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
    const flow = parameterValueFlowAtCall(db, site);
    const root = getAst(db, site.file)?.rootNode;
    const staticArguments = new Map<number, EvaluatedStaticValue>();
    if (root) {
      for (const unknown of flow.unknown) {
        const value = evaluateStaticValue({ db, file: site.file, root }, site.arguments[unknown.calleePosition]);
        if (value) staticArguments.set(unknown.calleePosition, value);
      }
    }
    mergeElements(result, programDataElementsForParameterFlow(flow, staticArguments));
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

function staticValueNode(
  flow: CallParameterValueFlow,
  calleePosition: number,
  value: EvaluatedStaticValue,
): ExplorationTopologyNode {
  return {
    id: id(
      'static-value',
      flow.call.file,
      String(flow.call.startLine),
      String(flow.call.endLine),
      String(calleePosition),
    ),
    kind: 'static-value',
    label: value.value,
    disposition: 'folded',
    location: { file: flow.call.file, line: flow.call.startLine, endLine: flow.call.endLine },
    anchorIds: [],
    attributes: {
      value: value.value,
      precision: value.precision,
      evidence: value.evidence,
      termKind: value.term.kind,
      derivationRule: value.derivation.rule,
    },
  };
}

function addStaticValueTransfer(
  edges: Map<string, ExplorationTopologyEdge>,
  nodes: Map<string, ExplorationTopologyNode>,
  flow: CallParameterValueFlow,
  calleePosition: number,
  argumentText: string,
  value: EvaluatedStaticValue,
): void {
  const source = staticValueNode(flow, calleePosition, value);
  const target = parameterNode(flow.callee, calleePosition);
  addNode(nodes, source);
  const edgeId = id(
    'edge',
    'static-value-transfer',
    flow.call.file,
    String(flow.call.startLine),
    String(calleePosition),
  );
  edges.set(edgeId, {
    id: edgeId,
    kind: 'data-transfer',
    fromNodeId: source.id,
    toNodeId: target.id,
    directed: true,
    disposition: 'folded',
    semantics: [
      {
        family: 'data',
        subtype: staticValueTransferSubtype(value),
        attributes: {
          argumentText,
          calleePosition,
          value: value.value,
          precision: value.precision,
          derivationRule: value.derivation.rule,
        },
      },
    ],
    evidence: staticValueEvidence(value, flow),
  });
}

function isProvedStaticValue(value: EvaluatedStaticValue): boolean {
  return value.derivation.kind !== 'heuristic' && value.precision !== 'symbolic' && value.precision !== 'unknown';
}

function staticValueTransferSubtype(value: EvaluatedStaticValue): string {
  if (value.derivation.rule === 'bounded-call-return') return 'return-to-parameter';
  if (value.derivation.rule === 'member-constant' || value.term.kind === 'property') return 'property-to-parameter';
  return 'constant-to-parameter';
}

function staticValueEvidence(
  value: EvaluatedStaticValue,
  flow: CallParameterValueFlow,
): ExplorationTopologyEdge['evidence'] {
  const spans = value.derivation.sourceSpans.length > 0 ? value.derivation.sourceSpans : [flow.call];
  return spans.map((span) => ({
    method: `static-value:${value.derivation.rule}`,
    strength: value.derivation.kind === 'direct' ? 'exact' : 'derived',
    identity: value.derivation.inputFactIds.join(',') || value.value,
    location: { file: span.file, line: span.startLine, endLine: span.endLine },
  }));
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
