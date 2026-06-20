import { difference, intersection, jaccard } from '../../analysis/similarity.js';
import {
  buildReactComponentBehaviorProfiles,
  type ReactComponentBehaviorProfile,
} from '../../source/react-profile.js';
import type { ScipDatabase } from '../../storage/db.js';
import { rankedPairwiseProfileResults, type PairwiseFileProfile } from '../internal/pairwise-profiles.js';

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
  const {
    minSimilarity = 0.45,
    minSharedBehaviors = 6,
    limit = 20,
    scope,
    scanLimit,
    filePattern,
  } = opts;
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
    sort: (a, b) => b.similarity - a.similarity
      || a.fileA.localeCompare(b.fileA)
      || a.componentA.localeCompare(b.componentA)
      || a.fileB.localeCompare(b.fileB)
      || a.componentB.localeCompare(b.componentB),
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
  return (requests >= 1 && namedBehavior >= 4)
    || (customHooks >= 1 && (requests >= 1 || namedStates >= 1 || handlers >= 2) && namedBehavior >= 5)
    || (namedStates >= 1 && handlers >= 2 && (effects >= 1 || reactHooks >= 2) && namedBehavior >= 5);
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
  if (parts.sharedHandlerVerbs.length) reasons.push(`shared action verbs: ${parts.sharedHandlerVerbs.slice(0, 6).join(', ')}`);
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
