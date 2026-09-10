import type { ScipDatabase } from '../../storage/db.js';
import { getSourceFacts } from '../../source/facts/source-facts.js';
import {
  scipOccurrenceCallTargetsForRange,
  scipOccurrenceTargetsForFile,
  sourceCallTargetUsesParameter,
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
    for (const { call, external, declarations, implementationReason } of unresolvedOwnerCalls(db, owner))
      appendUnresolvedCall(result, owner, call, external, declarations, implementationReason);
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
        !resolved.targets.some(
          (target) =>
            target.implementationStatus !== 'unresolved' && sameOccurrenceRange(target.sourceRange, call.targetRange),
        ),
    )
    .map((call) => ({
      call,
      external: isExternalInvocation(call, occurrences) && !sourceCallTargetUsesParameter(db, location.file, call),
      declarations: (resolved.declarations ?? [])
        .filter((target) => sameOccurrenceRange(target.sourceRange, call.targetRange))
        .map((target) => target.definition.symbol),
      implementationReason: resolved.targets.find((target) => sameOccurrenceRange(target.sourceRange, call.targetRange))
        ?.implementationReason,
    }));
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
  declarations: readonly string[],
  implementationReason?: string,
): void {
  const location = owner.location!;
  if (!call.targetRange) return;
  const resolutionReason =
    implementationReason ??
    (declarations.length
      ? 'observed-or-possible-write; execution-order-not-established'
      : 'missing-or-indirect-binding');
  const reason = declarations.length
    ? `Invocation ${call.calleeText} has no established repository implementation target at ${location.file}:${call.targetRange.startLine + 1}:${call.targetRange.startColumn + 1}. Compiler declaration reference for ${call.calleeText}: ${declarations.join(', ')}. Runtime implementation remains unresolved (${resolutionReason}); the declaration reference is preserved and does not establish executable reachability.`
    : external
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
    attributes: {
      ownerNodeId: owner.id,
      targetResolution: external && !declarations.length ? 'external' : 'unresolved',
      referencedDeclaration: declarations.length === 1 ? declarations[0]! : null,
      declarationCount: declarations.length,
      implementationReason: resolutionReason,
    },
  });
  result.edges.push({
    id: edgeId,
    kind: 'control-dependence',
    fromNodeId: owner.id,
    toNodeId: nodeId,
    directed: true,
    disposition: 'unsupported',
    semantics: [
      {
        family: 'control',
        subtype: 'unresolved-call-target',
        attributes: {
          referencedDeclaration: declarations.length === 1 ? declarations[0]! : null,
          declarationCount: declarations.length,
          implementationReason: resolutionReason,
        },
      },
    ],
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
