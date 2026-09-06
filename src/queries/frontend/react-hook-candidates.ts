import { difference, intersection } from '../../analysis/similarity.js';
import { frontendBehaviorProduct } from '../../source/frontend-behavior-products.js';
import type { ReactComponentBehaviorProfile } from '../../source/react-profile.js';
import type { ScipDatabase } from '../../storage/db.js';
import {
  pairwiseCandidateIndexFromKeys,
  rankedPairwiseProfileResults,
  type PairwiseFileProfile,
} from '../internal/pairwise-profiles.js';
import {
  behaviorSimilarity,
  classifyFrontendBehaviorEvidence,
  overlapGate,
  sortedTokens,
  tokenValues,
  type FrontendBehaviorActionTier,
  type FrontendBehaviorEvidenceClass,
} from '../internal/frontend-behavior-evidence.js';
import {
  FRONTEND_EXCLUSION_DETAILS,
  FrontendPolicyExclusions,
  frontendProfileRolePolicy,
  pairContextReason,
  type FrontendPairContext,
  type FrontendPolicyExclusion,
} from '../internal/frontend-profile-roles.js';

export type ReactHookEvidenceClass = FrontendBehaviorEvidenceClass;
export type ReactHookActionTier = FrontendBehaviorActionTier;

export interface ReactHookCandidateResult {
  fileA: string;
  componentA: string;
  fileB: string;
  componentB: string;
  similarity: number;
  tokenCountA: number;
  tokenCountB: number;
  sharedTokens: string[];
  sharedHooks: string[];
  sharedReactHooks: string[];
  sharedEffects: string[];
  sharedState: string[];
  sharedRequests: string[];
  sharedHandlers: string[];
  sharedHandlerVerbs: string[];
  evidenceClass: ReactHookEvidenceClass;
  actionTier: ReactHookActionTier;
  evidenceClassReasons: string[];
  recommendation: string;
  /** Whether both units are components or both are custom hooks. */
  unitKind: 'component' | 'hook';
  /** Structural relationship between the two files (route entries, intercepting routes, kit primitives). */
  pairContext: FrontendPairContext;
  uniqueToA: string[];
  uniqueToB: string[];
  reason: string;
  locA: number;
  locB: number;
}

export interface ReactHookCandidateScan {
  results: ReactHookCandidateResult[];
  /** Rows the role policy removed before ranking, disclosed by reason. */
  exclusions: FrontendPolicyExclusion[];
}

export interface ReactHookCandidateOptions {
  minSimilarity?: number;
  minSharedBehaviors?: number;
  limit?: number;
  scope?: string;
  scanLimit?: number;
  filePattern?: string;
  focusFiles?: ReadonlySet<string>;
}

interface ReactBehaviorPairwiseProfile extends PairwiseFileProfile {
  file: string;
  component: string;
  tokens: Set<string>;
  profile: ReactComponentBehaviorProfile;
}

// scip-query: ignore-similar - hook and component queries share profile ranking but report different React concepts.
export function reactHookCandidates(
  db: ScipDatabase,
  opts: ReactHookCandidateOptions = {},
): ReactHookCandidateResult[] {
  return reactHookCandidateScan(db, opts).results;
}

/**
 * Shared-behavior scan with its policy exclusions. Test-file units never
 * enter the comparison; a hook paired with a component is not an extraction
 * lead (the hook already is the extraction target, and a component that
 * re-implements it belongs to `recent-duplicates`); two vendored UI-kit
 * files share behavior by construction.
 */
// scip-query: ignore-extract — reviewed E1 workflow owner; profile selection, pair policy, and ranking are one scan contract.
export function reactHookCandidateScan(db: ScipDatabase, opts: ReactHookCandidateOptions = {}): ReactHookCandidateScan {
  const { minSimilarity = 0.45, minSharedBehaviors = 6, limit = 20, scope, scanLimit, filePattern, focusFiles } = opts;
  const policy = frontendProfileRolePolicy(db);
  const exclusions = new FrontendPolicyExclusions();
  const profiles = frontendBehaviorProduct(db)
    .reactProfiles({
      scope,
      minBehaviorTokens: Math.max(3, minSharedBehaviors),
      scanLimit,
    })
    .filter((profile) => {
      if (policy.roleOf(profile.file) !== 'test') return true;
      exclusions.record('test-files', FRONTEND_EXCLUSION_DETAILS.testFiles);
      return false;
    })
    .map((profile) => ({
      file: profile.file,
      component: profile.name,
      tokens: profile.behaviorTokens,
      profile,
    }));
  const candidateIndex = pairwiseCandidateIndexFromKeys(profiles, (profile) => profile.tokens);

  const results = rankedPairwiseProfileResults({
    profiles,
    limit,
    filePattern,
    focusFiles,
    candidateIndex,
    profile: { name: 'react-hook-candidates' },
    compare: (a, b) => {
      const context = policy.pairContext(a.file, b.file);
      const result = compareReactHookProfiles(a, b, minSimilarity, minSharedBehaviors, context);
      if (!result) return null;
      if (a.profile.kind !== b.profile.kind) {
        exclusions.record('hook-component-pairs', FRONTEND_EXCLUSION_DETAILS.hookComponentPairs);
        return null;
      }
      if (context === 'ui-kit-pair') {
        exclusions.record('ui-kit-pairs', FRONTEND_EXCLUSION_DETAILS.uiKitPairs);
        return null;
      }
      return result;
    },
    sort: (a, b) =>
      actionTierRank(a.actionTier) - actionTierRank(b.actionTier) ||
      b.similarity - a.similarity ||
      a.fileA.localeCompare(b.fileA) ||
      a.componentA.localeCompare(b.componentA) ||
      a.fileB.localeCompare(b.fileB) ||
      a.componentB.localeCompare(b.componentB),
  });
  return { results, exclusions: exclusions.list() };
}

function actionTierRank(tier: ReactHookActionTier): number {
  return tier === 'signal' ? 0 : 1;
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
function compareReactHookProfiles(
  a: ReactBehaviorPairwiseProfile,
  b: ReactBehaviorPairwiseProfile,
  minSimilarity: number,
  minSharedBehaviors: number,
  pairContext: FrontendPairContext,
): ReactHookCandidateResult | null {
  const shared = intersection(a.tokens, b.tokens);
  if (shared.size < minSharedBehaviors) return null;
  if (!hasMeaningfulReactBehaviorOverlap(shared)) return null;
  const similarity = behaviorSimilarity(a.tokens, b.tokens);
  if (similarity < minSimilarity) return null;

  const sharedHooks = tokenValues(shared, 'hook:');
  const sharedReactHooks = tokenValues(shared, 'react-hook:');
  const sharedEffects = tokenValues(shared, 'effect:');
  const sharedState = tokenValues(shared, 'state:');
  const sharedRequests = tokenValues(shared, 'request:');
  const sharedHandlers = tokenValues(shared, 'handler:');
  const sharedHandlerVerbs = tokenValues(shared, 'handler-verb:');
  const evidence = classifyReactHookEvidence({
    sharedHooks,
    sharedReactHooks,
    sharedEffects,
    sharedState,
    sharedRequests,
    sharedHandlers,
    sharedHandlerVerbs,
  });
  const contextReason = pairContextReason(pairContext);
  const verdict = pairContextVerdict(pairContext, evidence.actionTier, evidence.recommendation);

  return {
    fileA: a.file,
    componentA: a.component,
    fileB: b.file,
    componentB: b.component,
    similarity,
    tokenCountA: a.tokens.size,
    tokenCountB: b.tokens.size,
    sharedTokens: sortedTokens(shared),
    sharedHooks,
    sharedReactHooks,
    sharedEffects,
    sharedState,
    sharedRequests,
    sharedHandlers,
    sharedHandlerVerbs,
    evidenceClass: evidence.evidenceClass,
    actionTier: verdict.actionTier,
    evidenceClassReasons: contextReason ? [contextReason, ...evidence.reasons] : evidence.reasons,
    recommendation: verdict.recommendation,
    unitKind: a.profile.kind === 'hook' && b.profile.kind === 'hook' ? 'hook' : 'component',
    pairContext,
    uniqueToA: sortedTokens(difference(a.tokens, b.tokens)),
    uniqueToB: sortedTokens(difference(b.tokens, a.tokens)),
    reason: reactBehaviorReason({
      sharedHooks,
      sharedReactHooks,
      sharedEffects,
      sharedState,
      sharedRequests,
      sharedHandlers,
      sharedHandlerVerbs,
    }),
    locA: a.profile.loc,
    locB: b.profile.loc,
  };
}

function pairContextVerdict(
  pairContext: FrontendPairContext,
  actionTier: ReactHookActionTier,
  recommendation: string,
): { actionTier: ReactHookActionTier; recommendation: string } {
  switch (pairContext) {
    // Two route entries that share *behavior* (a fetch-then-redirect state
    // machine, a token check) share product logic, not routing scaffolding;
    // only structural overlap between route files is framework-shaped.
    case 'framework-route-pair':
      return { actionTier, recommendation };
    case 'intercepting-route-pair':
      return {
        actionTier,
        recommendation:
          'Render one shared view component from both the intercepting route and its target route instead of repeating the behavior in each body.',
      };
    case 'ui-kit-pair':
    case 'product':
      return { actionTier, recommendation };
  }
}

function classifyReactHookEvidence(parts: {
  sharedHooks: readonly string[];
  sharedReactHooks: readonly string[];
  sharedEffects: readonly string[];
  sharedState: readonly string[];
  sharedRequests: readonly string[];
  sharedHandlers: readonly string[];
  sharedHandlerVerbs: readonly string[];
}): {
  actionTier: ReactHookActionTier;
  evidenceClass: ReactHookEvidenceClass;
  recommendation: string;
  reasons: string[];
} {
  return classifyFrontendBehaviorEvidence({
    genericWords: GENERIC_REACT_BEHAVIOR_WORDS,
    stripPrefixes: REACT_BEHAVIOR_PREFIXES,
    primitiveGroups: [
      { values: parts.sharedReactHooks, reasonPrefix: 'shared React primitives', bucket: 'generic' },
      { values: parts.sharedEffects, reasonPrefix: 'shared lifecycle primitive', bucket: 'generic' },
    ],
    nameGroups: [
      { names: parts.sharedHooks, label: 'shared hook', fallbackBucket: 'shared-abstraction' },
      { names: parts.sharedRequests, label: 'shared request', fallbackBucket: 'generic' },
      { names: parts.sharedState, label: 'shared state', fallbackBucket: 'generic' },
      { names: parts.sharedHandlers, label: 'shared handler', fallbackBucket: 'generic' },
      { names: parts.sharedHandlerVerbs, label: 'shared action verb', fallbackBucket: 'generic' },
    ],
    recommendation: reactHookRecommendation,
  });
}

function reactHookRecommendation(evidenceClass: ReactHookEvidenceClass): string {
  switch (evidenceClass) {
    case 'domain-behavior':
      return 'Review for a shared hook, controller, or feature module around the named domain behavior.';
    case 'mixed':
      return 'Separate generic React mechanics from domain-specific behavior before extracting a shared hook.';
    case 'shared-abstraction':
      return 'Review the existing shared hook usage first; extract only if duplicated behavior remains outside it.';
    case 'generic-workflow-scaffolding':
      return 'Treat as support evidence for a repeated workflow shape, not direct hook-extraction evidence.';
  }
}

function hasMeaningfulReactBehaviorOverlap(shared: ReadonlySet<string>): boolean {
  let customHooks = 0;
  let reactHooks = 0;
  let effects = 0;
  let requests = 0;
  let handlers = 0;
  let namedStates = 0;
  let stateHooks = 0;
  for (const token of shared) {
    if (token.startsWith('hook:')) customHooks += 1;
    else if (token.startsWith('react-hook:')) reactHooks += 1;
    else if (token.startsWith('effect:')) effects += 1;
    else if (token.startsWith('request:')) requests += 1;
    else if (token.startsWith('handler:') || token.startsWith('handler-verb:')) handlers += 1;
    else if (token.startsWith('state:')) namedStates += 1;
    else if (token.startsWith('state-hook:')) stateHooks += 1;
  }
  const states = namedStates + stateHooks;
  const namedBehavior = customHooks + reactHooks + effects + requests + handlers + states;
  return overlapGate(
    [
      { name: 'requests', count: requests },
      { name: 'customHooks', count: customHooks },
      { name: 'namedStates', count: namedStates },
      { name: 'handlers', count: handlers },
      { name: 'effects', count: effects },
      { name: 'reactHooks', count: reactHooks },
      { name: 'namedBehavior', count: namedBehavior },
    ],
    [
      { min: { requests: 1, namedBehavior: 4 }, reason: 'shared request workflow' },
      { min: { customHooks: 1, requests: 1, namedBehavior: 5 }, reason: 'shared custom hook and request workflow' },
      { min: { customHooks: 1, namedStates: 1, namedBehavior: 5 }, reason: 'shared custom hook and state' },
      { min: { customHooks: 1, handlers: 2, namedBehavior: 5 }, reason: 'shared custom hook and handlers' },
      { min: { namedStates: 1, handlers: 2, effects: 1, namedBehavior: 5 }, reason: 'shared stateful effects' },
      {
        min: { namedStates: 1, handlers: 2, reactHooks: 2, namedBehavior: 5 },
        reason: 'shared stateful React primitives',
      },
    ],
  ).pass;
}

function reactBehaviorReason(parts: {
  sharedHooks: readonly string[];
  sharedReactHooks: readonly string[];
  sharedEffects: readonly string[];
  sharedState: readonly string[];
  sharedRequests: readonly string[];
  sharedHandlers: readonly string[];
  sharedHandlerVerbs: readonly string[];
}): string {
  const reasons: string[] = [];
  if (parts.sharedHooks.length) reasons.push(`shared hooks: ${parts.sharedHooks.join(', ')}`);
  if (parts.sharedReactHooks.length) reasons.push(`shared React hooks: ${parts.sharedReactHooks.join(', ')}`);
  if (parts.sharedEffects.length) reasons.push(`shared effects: ${parts.sharedEffects.join(', ')}`);
  if (parts.sharedState.length) reasons.push(`shared state: ${parts.sharedState.join(', ')}`);
  if (parts.sharedRequests.length) reasons.push(`shared requests: ${parts.sharedRequests.join(', ')}`);
  if (parts.sharedHandlers.length) reasons.push(`shared handlers: ${parts.sharedHandlers.slice(0, 6).join(', ')}`);
  if (parts.sharedHandlerVerbs.length)
    reasons.push(`shared action verbs: ${parts.sharedHandlerVerbs.slice(0, 6).join(', ')}`);
  return reasons.join('; ') || 'shared React behavior profile';
}

/**
 * Words that describe UI or data-fetching mechanics rather than a product
 * concept. Framework hook vocabulary belongs here too: `useQueryClient`,
 * `useMutation`, `useRouter`, and a `.mutate()` call are how every TanStack
 * Query or Next.js component talks to its runtime, so sharing them is not
 * evidence that two components implement the same domain behavior.
 */
const GENERIC_REACT_BEHAVIOR_WORDS = new Set([
  'add',
  'apply',
  'async',
  'callback',
  'cancel',
  'change',
  'clear',
  'client',
  'close',
  'context',
  'create',
  'data',
  'deferred',
  'delete',
  'dispatch',
  'draft',
  'edit',
  'effect',
  'error',
  'fetch',
  'field',
  'filter',
  'form',
  'handle',
  'has',
  'id',
  'infinite',
  'is',
  'item',
  'items',
  'load',
  'loader',
  'loading',
  'memo',
  'mutate',
  'mutation',
  'name',
  'navigate',
  'navigation',
  'open',
  'params',
  'pathname',
  'query',
  'reducer',
  'refresh',
  'ref',
  'remove',
  'request',
  'reset',
  'resource',
  'router',
  'row',
  'rows',
  'save',
  'saving',
  'search',
  'select',
  'selected',
  'selector',
  'state',
  'store',
  'submit',
  'suspense',
  'toggle',
  'transition',
  'update',
  'use',
  'value',
]);

const REACT_BEHAVIOR_PREFIXES = [/^use(?=[A-Z])/, /^handle(?=[A-Z])/, /^is(?=[A-Z])/, /^has(?=[A-Z])/] as const;
