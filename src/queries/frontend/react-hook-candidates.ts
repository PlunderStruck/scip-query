import { difference, intersection, jaccard } from '../../analysis/similarity.js';
import { buildReactComponentBehaviorProfiles, type ReactComponentBehaviorProfile } from '../../source/react-profile.js';
import type { ScipDatabase } from '../../storage/db.js';
import { rankedPairwiseProfileResults, type PairwiseFileProfile } from '../internal/pairwise-profiles.js';

export type ReactHookEvidenceClass =
  | 'domain-behavior'
  | 'generic-workflow-scaffolding'
  | 'mixed'
  | 'shared-abstraction';
export type ReactHookActionTier = 'signal' | 'support';

export interface ReactHookCandidateResult {
  fileA: string;
  componentA: string;
  fileB: string;
  componentB: string;
  similarity: number;
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
  uniqueToA: string[];
  uniqueToB: string[];
  reason: string;
  locA: number;
  locB: number;
}

interface ReactBehaviorPairwiseProfile extends PairwiseFileProfile {
  file: string;
  component: string;
  tokens: Set<string>;
  profile: ReactComponentBehaviorProfile;
}

export function reactHookCandidates(
  db: ScipDatabase,
  opts: {
    minSimilarity?: number;
    minSharedBehaviors?: number;
    limit?: number;
    scope?: string;
    scanLimit?: number;
    filePattern?: string;
  } = {},
): ReactHookCandidateResult[] {
  const { minSimilarity = 0.45, minSharedBehaviors = 6, limit = 20, scope, scanLimit, filePattern } = opts;
  const profiles = buildReactComponentBehaviorProfiles(db, {
    scope,
    minBehaviorTokens: Math.max(3, minSharedBehaviors),
    scanLimit,
  }).map((profile) => ({
    file: profile.file,
    component: profile.name,
    tokens: profile.behaviorTokens,
    profile,
  }));

  return rankedPairwiseProfileResults({
    profiles,
    limit,
    filePattern,
    compare: (a, b) => compareProfiles(a, b, minSimilarity, minSharedBehaviors),
    sort: (a, b) =>
      b.similarity - a.similarity ||
      a.fileA.localeCompare(b.fileA) ||
      a.componentA.localeCompare(b.componentA) ||
      a.fileB.localeCompare(b.fileB) ||
      a.componentB.localeCompare(b.componentB),
  });
}

function compareProfiles(
  a: ReactBehaviorPairwiseProfile,
  b: ReactBehaviorPairwiseProfile,
  minSimilarity: number,
  minSharedBehaviors: number,
): ReactHookCandidateResult | null {
  const shared = intersection(a.tokens, b.tokens);
  if (shared.size < minSharedBehaviors) return null;
  if (!hasMeaningfulBehaviorOverlap(shared)) return null;
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

  return {
    fileA: a.file,
    componentA: a.component,
    fileB: b.file,
    componentB: b.component,
    similarity,
    sharedTokens: sortedTokens(shared),
    sharedHooks,
    sharedReactHooks,
    sharedEffects,
    sharedState,
    sharedRequests,
    sharedHandlers,
    sharedHandlerVerbs,
    evidenceClass: evidence.evidenceClass,
    actionTier: evidence.actionTier,
    evidenceClassReasons: evidence.reasons,
    recommendation: evidence.recommendation,
    uniqueToA: sortedTokens(difference(a.tokens, b.tokens)).slice(0, 25),
    uniqueToB: sortedTokens(difference(b.tokens, a.tokens)).slice(0, 25),
    reason: behaviorReason({
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
  const domainReasons: string[] = [];
  const genericReasons: string[] = [];
  const sharedAbstractionReasons: string[] = [];

  if (parts.sharedReactHooks.length) {
    genericReasons.push(`shared React primitives: ${parts.sharedReactHooks.join(', ')}`);
  }
  if (parts.sharedEffects.length) {
    genericReasons.push(`shared lifecycle primitive: ${parts.sharedEffects.join(', ')}`);
  }
  classifyNames(parts.sharedHooks, 'shared hook', domainReasons, sharedAbstractionReasons);
  classifyNames(parts.sharedRequests, 'shared request', domainReasons, genericReasons);
  classifyNames(parts.sharedState, 'shared state', domainReasons, genericReasons);
  classifyNames(parts.sharedHandlers, 'shared handler', domainReasons, genericReasons);
  classifyNames(parts.sharedHandlerVerbs, 'shared action verb', domainReasons, genericReasons);

  const hasDomain = domainReasons.length > 0;
  const hasGeneric = genericReasons.length > 0;
  const hasSharedAbstraction = sharedAbstractionReasons.length > 0;
  const evidenceClass: ReactHookEvidenceClass = hasDomain
    ? hasGeneric || hasSharedAbstraction
      ? 'mixed'
      : 'domain-behavior'
    : hasSharedAbstraction
      ? 'shared-abstraction'
      : 'generic-workflow-scaffolding';
  const actionTier: ReactHookActionTier =
    evidenceClass === 'domain-behavior' || evidenceClass === 'mixed' ? 'signal' : 'support';
  const reasons = [...domainReasons, ...sharedAbstractionReasons, ...genericReasons].slice(0, 6);
  return {
    actionTier,
    evidenceClass,
    reasons,
    recommendation: reactHookRecommendation(evidenceClass),
  };
}

function classifyNames(
  names: readonly string[],
  label: string,
  domainReasons: string[],
  genericReasons: string[],
): void {
  const domainNames: string[] = [];
  const genericNames: string[] = [];
  for (const name of names) {
    if (hasDomainBehaviorWords(name)) {
      domainNames.push(name);
    } else {
      genericNames.push(name);
    }
  }
  if (domainNames.length) domainReasons.push(`${label} has domain term(s): ${domainNames.slice(0, 6).join(', ')}`);
  if (genericNames.length) genericReasons.push(`${label} is generic workflow: ${genericNames.slice(0, 6).join(', ')}`);
}

function hasDomainBehaviorWords(name: string): boolean {
  const words = behaviorWords(name).filter((word) => !GENERIC_REACT_BEHAVIOR_WORDS.has(word));
  return words.length > 0;
}

function behaviorWords(name: string): string[] {
  return name
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^use(?=[A-Z])/, '')
    .replace(/^handle(?=[A-Z])/, '')
    .replace(/^is(?=[A-Z])/, '')
    .replace(/^has(?=[A-Z])/, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
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

function behaviorSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const shared = intersection(a, b).size;
  const overlap = shared / Math.min(a.size, b.size);
  return Math.max(jaccard(a, b), overlap);
}

function hasMeaningfulBehaviorOverlap(shared: ReadonlySet<string>): boolean {
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
  return (
    (requests >= 1 && namedBehavior >= 4) ||
    (customHooks >= 1 && (requests >= 1 || namedStates >= 1 || handlers >= 2) && namedBehavior >= 5) ||
    (namedStates >= 1 && handlers >= 2 && (effects >= 1 || reactHooks >= 2) && namedBehavior >= 5)
  );
}

function behaviorReason(parts: {
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

function tokenValues(tokens: ReadonlySet<string>, prefix: string): string[] {
  return [...tokens]
    .filter((token) => token.startsWith(prefix))
    .map((token) => token.slice(prefix.length))
    .sort();
}

function sortedTokens(tokens: ReadonlySet<string>): string[] {
  return [...tokens].sort();
}

const GENERIC_REACT_BEHAVIOR_WORDS = new Set([
  'add',
  'apply',
  'async',
  'callback',
  'cancel',
  'change',
  'clear',
  'close',
  'create',
  'data',
  'delete',
  'draft',
  'edit',
  'effect',
  'error',
  'fetch',
  'filter',
  'form',
  'handle',
  'has',
  'is',
  'item',
  'items',
  'load',
  'loader',
  'loading',
  'memo',
  'name',
  'open',
  'reducer',
  'refresh',
  'ref',
  'remove',
  'request',
  'reset',
  'resource',
  'row',
  'rows',
  'save',
  'saving',
  'search',
  'select',
  'selected',
  'state',
  'store',
  'submit',
  'toggle',
  'update',
  'use',
  'value',
]);
