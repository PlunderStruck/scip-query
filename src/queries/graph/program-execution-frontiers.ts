import type { ScipDatabase } from '../../storage/db.js';
import { getSourceFacts } from '../../source/facts/source-facts.js';
import {
  scipOccurrenceCallTargetsForRange,
  scipOccurrenceTargetsForFile,
} from '../../symbols/graph/scip-occurrence-call-targets.js';
import { sameOccurrenceRange } from '../../symbols/graph/scip-chunk-occurrences.js';
import type { ExplorationTopologyNode } from '../internal/exploration-topology.js';
import type { SourceFacts } from '../../source/facts/source-fact-types.js';
import type { ProgramControlElements } from './program-control-edges.js';

/** Keep parsed invocations with no concrete repository target visible in execution coverage. */
export function programExecutionFrontiers(
  db: ScipDatabase,
  owners: readonly ExplorationTopologyNode[],
): ProgramControlElements {
  const result: ProgramControlElements = { nodes: [], edges: [], frontiers: [], blindSpots: [] };
  for (const owner of owners) {
    for (const { call, external } of unresolvedOwnerCalls(db, owner))
      appendUnresolvedCall(result, owner, call, external);
  }
  return result;
}

function unresolvedOwnerCalls(db: ScipDatabase, owner: ExplorationTopologyNode) {
  const location = owner.location;
  if (!location || !['symbol', 'source-construct', 'file'].includes(owner.kind)) return [];
  const facts = getSourceFacts(db, location.file);
  if (!facts) return [];
  const resolved = scipOccurrenceCallTargetsForRange(
    db,
    location.file,
    location.line,
    owner.kind === 'file' ? Number.MAX_SAFE_INTEGER : (location.endLine ?? location.line),
  );
  const occurrences = scipOccurrenceTargetsForFile(db, location.file);
  return facts.callSites
    .filter(
      (call) =>
        callBelongsToOwner(call, owner) &&
        !resolved.targets.some((target) => sameOccurrenceRange(target.sourceRange, call.targetRange)),
    )
    .map((call) => ({ call, external: isExternalInvocation(call, occurrences) }));
}

function callBelongsToOwner(call: SourceFacts['callSites'][number], owner: ExplorationTopologyNode): boolean {
  if (!call.targetRange) return false;
  if (owner.kind === 'file') return call.owner === null;
  const location = owner.location!;
  return (
    call.owner?.startLine === location.line &&
    call.owner.endLine === location.endLine &&
    call.owner.startColumn === location.startColumn &&
    call.owner.endColumn === location.endColumn
  );
}

function isExternalInvocation(
  call: SourceFacts['callSites'][number],
  occurrences: ReturnType<typeof scipOccurrenceTargetsForFile>,
): boolean {
  const local = occurrences?.locals?.some((binding) =>
    sameOccurrenceRange(
      { startLine: binding.line, startColumn: binding.startChar, endLine: binding.endLine, endColumn: binding.endChar },
      call.targetRange,
    ),
  );
  return !local && !!occurrences?.externalRanges?.some((range) => sameOccurrenceRange(range, call.targetRange));
}

function appendUnresolvedCall(
  result: ProgramControlElements,
  owner: ExplorationTopologyNode,
  call: SourceFacts['callSites'][number],
  external: boolean,
): void {
  const location = owner.location!;
  if (!call.targetRange) return;
  const reason = external
    ? `Compiler reference for ${call.calleeText} has no indexed repository body; external behavior is unavailable.`
    : `Invocation ${call.calleeText} has no established repository implementation target; indirect, mutated, or missing bindings cannot establish reachability.`;
  const nodeId = `execution-unresolved:${owner.id}:${call.targetRange.startLine}:${call.targetRange.startColumn}:${call.targetRange.endColumn}`;
  const edgeId = `edge:${nodeId}`;
  const site = {
    file: location.file,
    line: call.targetRange.startLine,
    endLine: call.targetRange.endLine,
    startColumn: call.targetRange.startColumn,
    endColumn: call.targetRange.endColumn,
  };
  result.nodes.push({
    id: nodeId,
    kind: 'unresolved-invocation',
    label: call.calleeText ?? call.calleeLeaf,
    disposition: 'unsupported',
    location: site,
    anchorIds: [],
    attributes: { ownerNodeId: owner.id, targetResolution: external ? 'external' : 'unresolved' },
  });
  result.edges.push({
    id: edgeId,
    kind: 'control-dependence',
    fromNodeId: owner.id,
    toNodeId: nodeId,
    directed: true,
    disposition: 'unsupported',
    semantics: [{ family: 'control', subtype: 'unresolved-call-target' }],
    evidence: [
      {
        method: 'parser-invocation-without-repository-target',
        strength: 'exact',
        identity: reason,
        location: site,
      },
    ],
  });
  result.frontiers.push({
    id: `frontier:${nodeId}`,
    kind: 'control-dependence',
    direction: 'unresolved',
    fromNodeIds: [owner.id],
    edgeIds: [edgeId],
    memberNodeIds: [nodeId],
    memberCount: 1,
    disposition: 'unsupported',
    reason,
    expansion: null,
  });
}
