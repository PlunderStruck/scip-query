import type { PlanAffectedSeed, PlanContractRecordV1, PlanReuseAuthority } from '../../change-control/plan-contract.js';
import type { ScipDatabase } from '../../storage/db.js';
import { createPerDbValue } from '../../storage/per-db-cache.js';
import { getAst, type SyntaxNode } from '../../source/ast.js';
import { referenceSitesForSymbol } from '../../symbols/references/reference-sites.js';
import { leafName } from '../../symbols/symbol-parser.js';
import { findExactSymbolMatch, resolveSymbol } from '../../symbols/symbol-lookup.js';
import { symbolSemanticEvidence } from '../../semantic/symbol-evidence.js';
import { callableCalleeEvidence } from '../internal/callee-evidence.js';

export interface ResolvedPlanReferent {
  symbol: string;
  file: string;
}

export type PlanReuseCalleeEvidence =
  | { state: 'complete'; values: readonly ResolvedPlanReferent[] }
  | { state: 'unknown'; reason: string };

export type PlanReuseCallableArgumentEvidence =
  | { state: 'found'; file: string; line: number }
  | { state: 'not-found' }
  | { state: 'unknown'; reason: string };

export interface PlanReuseRuntime {
  resolve(
    db: ScipDatabase,
    referent: string,
  ): { state: 'resolved'; value: ResolvedPlanReferent } | { state: 'unknown'; reason: string };
  callees(db: ScipDatabase, referent: ResolvedPlanReferent): PlanReuseCalleeEvidence;
  /**
   * Strong higher-order evidence: the authority is compiler-resolved inside
   * this consumer and source structure places it in a call argument.
   */
  callableArgument?(
    db: ScipDatabase,
    consumer: ResolvedPlanReferent,
    authority: ResolvedPlanReferent,
  ): PlanReuseCallableArgumentEvidence;
}

export interface PlanReusePathEdge {
  from: ResolvedPlanReferent;
  to: ResolvedPlanReferent;
  kind: 'call' | 'callable-argument';
  file: string;
  line?: number;
}

export interface PlanReuseFrontierEntry extends ResolvedPlanReferent {
  depth: number;
  reason: 'graph-end' | 'cycle-closed' | 'depth-limit' | 'node-limit' | 'evidence-unavailable';
  detail?: string;
}

export interface PlanReuseConsumerEvaluation {
  seedId: string;
  referent: string;
  disposition: 'established' | 'contradiction' | 'insufficient-evidence';
  observedPath: PlanReusePathEdge[];
  frontier: PlanReuseFrontierEntry[];
  truncated: boolean;
  reason: string;
}

export interface PlanReuseAuthorityEvaluation {
  planId: string;
  itemId: string;
  authority: PlanReuseAuthority;
  disposition: 'established' | 'contradiction' | 'insufficient-evidence';
  consumers: PlanReuseConsumerEvaluation[];
  missingConsumers: PlanReuseConsumerEvaluation[];
  reasons: string[];
}

export interface PlanReuseAuthorityResult {
  coverage: { state: 'complete' | 'partial'; omitted: Array<{ planId: string; itemId: string; reason: string }> };
  evaluations: PlanReuseAuthorityEvaluation[];
}

export interface PlanReuseTraversalOptions {
  maxDepth?: number;
  maxVisited?: number;
}

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_VISITED = 100;
const AUTHORITY_REFERENCE_SITES = createPerDbValue<
  Map<string, Array<{ file: string; line: number; enclosingSymbol: string | null }>>
>('plan-reuse-authority-reference-sites', { clearGroups: ['whole-project'] });

const DEFAULT_RUNTIME: PlanReuseRuntime = {
  resolve(db, referent) {
    const resolution = resolveSymbol(db, referent);
    if (!resolution.match) return { state: 'unknown', reason: `${referent} does not resolve to a current symbol` };
    if (resolution.total !== 1) {
      return {
        state: 'unknown',
        reason: `${referent} resolves to ${resolution.total} symbols; use a qualified referent`,
      };
    }
    return {
      state: 'resolved',
      value: {
        symbol: resolution.match.symbol,
        file: resolution.match.relativePath,
      },
    };
  },
  callees(db, referent) {
    const match = findExactSymbolMatch(db, referent.symbol);
    if (!match) return { state: 'unknown', reason: `${referent.symbol} no longer resolves exactly` };
    return {
      state: 'complete',
      values: callableCalleeEvidence(db, match),
    };
  },
  callableArgument: callableArgumentEvidence,
};

/**
 * Check selected reuse authorities against compiler-resolved graph and
 * higher-order argument evidence. A contradiction requires an exhausted
 * search. A bounded or unavailable search remains insufficient evidence.
 */
export function planReuseAuthority(
  db: ScipDatabase,
  plans: readonly PlanContractRecordV1[],
  runtime: PlanReuseRuntime = DEFAULT_RUNTIME,
  options: PlanReuseTraversalOptions = {},
): PlanReuseAuthorityResult {
  const maxDepth = normalizedBound(options.maxDepth, DEFAULT_MAX_DEPTH);
  const maxVisited = normalizedBound(options.maxVisited, DEFAULT_MAX_VISITED);
  const omitted: PlanReuseAuthorityResult['coverage']['omitted'] = [];
  const evaluations: PlanReuseAuthorityEvaluation[] = [];
  for (const plan of plans) {
    const seeds = new Map(plan.affectedSeeds.map((seed) => [seed.id, seed]));
    for (const authority of plan.reuseAuthorities) {
      const resolvedAuthority = runtime.resolve(db, authority.referent);
      if (resolvedAuthority.state === 'unknown') {
        omitted.push({ planId: plan.planId, itemId: authority.id, reason: resolvedAuthority.reason });
        evaluations.push({
          planId: plan.planId,
          itemId: authority.id,
          authority,
          disposition: 'insufficient-evidence',
          consumers: [],
          missingConsumers: [],
          reasons: [resolvedAuthority.reason],
        });
        continue;
      }

      const consumers = authority.consumerSeedIds.map((seedId) =>
        evaluateConsumerDelegation(
          db,
          seeds.get(seedId),
          seedId,
          resolvedAuthority.value,
          runtime,
          maxDepth,
          maxVisited,
        ),
      );
      for (const consumer of consumers) {
        if (consumer.disposition !== 'insufficient-evidence') continue;
        omitted.push({
          planId: plan.planId,
          itemId: authority.id,
          reason: `${consumer.referent}: ${consumer.reason}`,
        });
      }
      const missingConsumers = consumers.filter((consumer) => consumer.disposition === 'contradiction');
      const disposition =
        missingConsumers.length > 0
          ? 'contradiction'
          : consumers.some((consumer) => consumer.disposition === 'insufficient-evidence')
            ? 'insufficient-evidence'
            : 'established';
      evaluations.push({
        planId: plan.planId,
        itemId: authority.id,
        authority,
        disposition,
        consumers,
        missingConsumers,
        reasons:
          disposition === 'established'
            ? [
                `${authority.referent} is reached by compiler-supported delegation evidence from all ${authority.consumerSeedIds.length} named consumers.`,
              ]
            : consumers
                .filter((consumer) => consumer.disposition !== 'established')
                .map((consumer) => `${consumer.referent}: ${consumer.reason}`),
      });
    }
  }
  return {
    coverage: { state: omitted.length === 0 ? 'complete' : 'partial', omitted },
    evaluations,
  };
}

interface SearchNode {
  referent: ResolvedPlanReferent;
  depth: number;
  path: PlanReusePathEdge[];
}

function evaluateConsumerDelegation(
  db: ScipDatabase,
  seed: PlanAffectedSeed | undefined,
  seedId: string,
  authority: ResolvedPlanReferent,
  runtime: PlanReuseRuntime,
  maxDepth: number,
  maxVisited: number,
): PlanReuseConsumerEvaluation {
  if (!seed) return unavailableConsumer(seedId, seedId, 'the affected seed is missing');
  if (seed.kind !== 'symbol') {
    return unavailableConsumer(seedId, seed.referent, 'the consumer seed is not a symbol');
  }
  const consumer = runtime.resolve(db, seed.referent);
  if (consumer.state === 'unknown') return unavailableConsumer(seedId, seed.referent, consumer.reason);
  if (sameReferent(consumer.value, authority)) {
    return establishedConsumer(seedId, seed.referent, [], 'the consumer is the selected owner');
  }

  const queue: SearchNode[] = [{ referent: consumer.value, depth: 0, path: [] }];
  const visited = new Set<string>([referentKey(consumer.value)]);
  const frontier: PlanReuseFrontierEntry[] = [];
  let incomplete = false;

  while (queue.length > 0) {
    const current = queue.shift()!;
    const callback = runtime.callableArgument?.(db, current.referent, authority) ?? { state: 'not-found' as const };
    if (callback.state === 'found') {
      const edge: PlanReusePathEdge = {
        from: current.referent,
        to: authority,
        kind: 'callable-argument',
        file: callback.file,
        line: callback.line,
      };
      return establishedConsumer(
        seedId,
        seed.referent,
        [...current.path, edge],
        `compiler-resolved callable-argument evidence reaches ${authority.symbol}`,
      );
    }
    if (callback.state === 'unknown') {
      incomplete = true;
      frontier.push(frontierEntry(current, 'evidence-unavailable', callback.reason));
    }

    const calleeEvidence = runtime.callees(db, current.referent);
    if (calleeEvidence.state === 'unknown') {
      incomplete = true;
      frontier.push(frontierEntry(current, 'evidence-unavailable', calleeEvidence.reason));
      continue;
    }
    const unvisitedCallees = calleeEvidence.values.filter((callee) => !visited.has(referentKey(callee)));
    const directAuthority = calleeEvidence.values.find((callee) => sameReferent(callee, authority));
    if (directAuthority) {
      const edge: PlanReusePathEdge = {
        from: current.referent,
        to: authority,
        kind: 'call',
        file: directAuthority.file,
      };
      return establishedConsumer(
        seedId,
        seed.referent,
        [...current.path, edge],
        `compiler-resolved call path reaches ${authority.symbol}`,
      );
    }
    if (unvisitedCallees.length === 0) {
      frontier.push(frontierEntry(current, calleeEvidence.values.length === 0 ? 'graph-end' : 'cycle-closed'));
      continue;
    }
    if (current.depth >= maxDepth) {
      incomplete = true;
      for (const callee of unvisitedCallees) {
        frontier.push({ ...callee, depth: current.depth + 1, reason: 'depth-limit' });
      }
      continue;
    }

    for (const callee of unvisitedCallees) {
      if (visited.size >= maxVisited) {
        incomplete = true;
        frontier.push({ ...callee, depth: current.depth + 1, reason: 'node-limit' });
        continue;
      }
      visited.add(referentKey(callee));
      queue.push({
        referent: callee,
        depth: current.depth + 1,
        path: [...current.path, { from: current.referent, to: callee, kind: 'call', file: callee.file }],
      });
    }
  }

  const shallowestFrontier = shallowestUniqueFrontier(frontier);
  if (incomplete) {
    return {
      seedId,
      referent: seed.referent,
      disposition: 'insufficient-evidence',
      observedPath: [],
      frontier: shallowestFrontier,
      truncated: true,
      reason: `delegation search ended without complete coverage before reaching ${authority.symbol}`,
    };
  }
  return {
    seedId,
    referent: seed.referent,
    disposition: 'contradiction',
    observedPath: [],
    frontier: shallowestFrontier,
    truncated: false,
    reason: `the exhausted compiler-resolved graph has no call or callable-argument path to ${authority.symbol}`,
  };
}

function callableArgumentEvidence(
  db: ScipDatabase,
  consumer: ResolvedPlanReferent,
  authority: ResolvedPlanReferent,
): PlanReuseCallableArgumentEvidence {
  const authorityMatch = findExactSymbolMatch(db, authority.symbol);
  if (!authorityMatch) return { state: 'unknown', reason: `${authority.symbol} no longer resolves exactly` };
  const byAuthority = AUTHORITY_REFERENCE_SITES.get(db, () => new Map());
  let authoritySites = byAuthority.get(authority.symbol);
  if (!authoritySites) {
    authoritySites = referenceSitesForSymbol(db, authorityMatch, {
      semantic: true,
      semanticEvidence: symbolSemanticEvidence,
    });
    byAuthority.set(authority.symbol, authoritySites);
  }
  const sites = authoritySites.filter((site) => site.enclosingSymbol === consumer.symbol);
  if (sites.length === 0) return { state: 'not-found' };

  let unavailable = false;
  const authorityLeaf = leafName(authority.symbol);
  for (const site of sites) {
    const tree = getAst(db, site.file);
    if (!tree) {
      unavailable = true;
      continue;
    }
    if (isIdentifierInsideCallArgument(tree.rootNode, authorityLeaf, site.line)) {
      return { state: 'found', file: site.file, line: site.line };
    }
  }
  return unavailable
    ? { state: 'unknown', reason: `a compiler-resolved reference exists, but ${consumer.file} has no supported AST` }
    : { state: 'not-found' };
}

const CALL_NODE_TYPES = [
  'call_expression',
  'new_expression',
  'call',
  'invocation_expression',
  'object_creation_expression',
];
const ARGUMENT_NODE_TYPES = new Set(['arguments', 'argument_list', 'value_arguments']);

function isIdentifierInsideCallArgument(root: SyntaxNode, identifier: string, line: number): boolean {
  if (!identifier) return false;
  for (const call of root.descendantsOfType(CALL_NODE_TYPES)) {
    const args = call.namedChildren.find((child) => ARGUMENT_NODE_TYPES.has(child.type));
    if (!args || line < args.startPosition.row || line > args.endPosition.row) continue;
    if (containsLeafAtLine(args, identifier, line)) return true;
  }
  return false;
}

function containsLeafAtLine(node: SyntaxNode, identifier: string, line: number): boolean {
  if (line < node.startPosition.row || line > node.endPosition.row) return false;
  if (node.namedChildCount === 0) return node.text === identifier;
  return node.namedChildren.some((child) => containsLeafAtLine(child, identifier, line));
}

function establishedConsumer(
  seedId: string,
  referent: string,
  observedPath: PlanReusePathEdge[],
  reason: string,
): PlanReuseConsumerEvaluation {
  return {
    seedId,
    referent,
    disposition: 'established',
    observedPath,
    frontier: [],
    truncated: false,
    reason,
  };
}

function unavailableConsumer(seedId: string, referent: string, reason: string): PlanReuseConsumerEvaluation {
  return {
    seedId,
    referent,
    disposition: 'insufficient-evidence',
    observedPath: [],
    frontier: [],
    truncated: true,
    reason,
  };
}

function frontierEntry(
  node: SearchNode,
  reason: PlanReuseFrontierEntry['reason'],
  detail?: string,
): PlanReuseFrontierEntry {
  return { ...node.referent, depth: node.depth, reason, ...(detail ? { detail } : {}) };
}

function shallowestUniqueFrontier(frontier: readonly PlanReuseFrontierEntry[]): PlanReuseFrontierEntry[] {
  if (frontier.length === 0) return [];
  const minDepth = Math.min(...frontier.map((entry) => entry.depth));
  const byKey = new Map<string, PlanReuseFrontierEntry>();
  for (const entry of frontier) {
    if (entry.depth !== minDepth) continue;
    byKey.set(`${referentKey(entry)}|${entry.reason}`, entry);
  }
  return [...byKey.values()].sort((left, right) => left.symbol.localeCompare(right.symbol)).slice(0, 10);
}

function sameReferent(left: ResolvedPlanReferent, right: ResolvedPlanReferent): boolean {
  return left.symbol === right.symbol;
}

function referentKey(referent: ResolvedPlanReferent): string {
  return `${referent.symbol}|${referent.file}`;
}

function normalizedBound(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}
