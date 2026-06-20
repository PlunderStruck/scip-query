import { difference, intersection, jaccard } from '../../analysis/similarity.js';
import {
  buildVueComponentBehaviorProfiles,
  type VueComponentBehaviorProfile,
} from '../../source/vue-profile.js';
import type { ScipDatabase } from '../../storage/db.js';
import { rankedPairwiseProfileResults, type PairwiseFileProfile } from '../internal/pairwise-profiles.js';

export interface VueComposableCandidateResult {
  fileA: string;
  fileB: string;
  similarity: number;
  sharedTokens: string[];
  sharedComposables: string[];
  sharedStores: string[];
  sharedReactivity: string[];
  sharedLifecycle: string[];
  sharedRequests: string[];
  sharedFunctions: string[];
  sharedFunctionVerbs: string[];
  sharedBindings: string[];
  sharedTemplateEvents: string[];
  uniqueToA: string[];
  uniqueToB: string[];
  reason: string;
  locA: number;
  locB: number;
}

interface VueBehaviorPairwiseProfile extends PairwiseFileProfile {
  file: string;
  tokens: Set<string>;
  profile: VueComponentBehaviorProfile;
}

export function vueComposableCandidates(
  db: ScipDatabase,
  opts: {
    minSimilarity?: number;
    minSharedBehaviors?: number;
    limit?: number;
    scope?: string;
    scanLimit?: number;
    filePattern?: string;
  } = {},
): VueComposableCandidateResult[] {
  const {
    minSimilarity = 0.45,
    minSharedBehaviors = 6,
    limit = 20,
    scope,
    scanLimit,
    filePattern,
  } = opts;
  const profiles = buildVueComponentBehaviorProfiles(db, {
    scope,
    minBehaviorTokens: Math.max(3, minSharedBehaviors),
    scanLimit,
  }).map((profile) => ({
    file: profile.file,
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
      || a.fileB.localeCompare(b.fileB),
  });
}

function compareProfiles(
  a: VueBehaviorPairwiseProfile,
  b: VueBehaviorPairwiseProfile,
  minSimilarity: number,
  minSharedBehaviors: number,
): VueComposableCandidateResult | null {
  const shared = intersection(a.tokens, b.tokens);
  if (shared.size < minSharedBehaviors) return null;
  if (!hasMeaningfulBehaviorOverlap(shared)) return null;
  const similarity = behaviorSimilarity(a.tokens, b.tokens);
  if (similarity < minSimilarity) return null;

  const sharedComposables = tokenValues(shared, 'composable:');
  const sharedStores = tokenValues(shared, 'store:');
  const sharedReactivity = tokenValues(shared, 'reactivity:');
  const sharedLifecycle = tokenValues(shared, 'lifecycle:');
  const sharedRequests = tokenValues(shared, 'request:');
  const sharedFunctions = tokenValues(shared, 'function:');
  const sharedFunctionVerbs = tokenValues(shared, 'function-verb:');
  const sharedBindings = tokenValues(shared, 'template-binding:');
  const sharedTemplateEvents = tokenValues(shared, 'template-event:');

  return {
    fileA: a.file,
    fileB: b.file,
    similarity,
    sharedTokens: sortedTokens(shared),
    sharedComposables,
    sharedStores,
    sharedReactivity,
    sharedLifecycle,
    sharedRequests,
    sharedFunctions,
    sharedFunctionVerbs,
    sharedBindings,
    sharedTemplateEvents,
    uniqueToA: sortedTokens(difference(a.tokens, b.tokens)).slice(0, 25),
    uniqueToB: sortedTokens(difference(b.tokens, a.tokens)).slice(0, 25),
    reason: behaviorReason({
      sharedComposables,
      sharedStores,
      sharedRequests,
      sharedLifecycle,
      sharedFunctions,
      sharedFunctionVerbs,
      sharedBindings,
    }),
    locA: a.profile.totalLines,
    locB: b.profile.totalLines,
  };
}

function behaviorSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const shared = intersection(a, b).size;
  const overlap = shared / Math.min(a.size, b.size);
  return Math.max(jaccard(a, b), overlap);
}

function hasMeaningfulBehaviorOverlap(shared: ReadonlySet<string>): boolean {
  let composableBehavior = 0;
  let storeBehavior = 0;
  let requestBehavior = 0;
  let lifecycleBehavior = 0;
  let functionBehavior = 0;
  let reactivityBehavior = 0;
  let supportingBehavior = 0;
  for (const token of shared) {
    if (token.startsWith('composable:')) {
      composableBehavior += 1;
    } else if (token.startsWith('store:')) {
      storeBehavior += 1;
    } else if (token.startsWith('request:')) {
      requestBehavior += 1;
    } else if (token.startsWith('lifecycle:')) {
      lifecycleBehavior += 1;
    } else if (token.startsWith('function:')) {
      functionBehavior += 1;
    } else if (token.startsWith('reactivity:')) {
      reactivityBehavior += 1;
    } else if (
      token.startsWith('function-verb:')
      || token.startsWith('template-binding:')
      || token.startsWith('template-event:')
    ) {
      supportingBehavior += 1;
    }
  }
  const reusableHookBehavior = composableBehavior + storeBehavior;
  const namedBehavior = reusableHookBehavior + requestBehavior + lifecycleBehavior + functionBehavior + supportingBehavior;
  return (requestBehavior >= 1 && namedBehavior >= 4)
    || (lifecycleBehavior >= 1 && functionBehavior >= 2 && namedBehavior >= 4)
    || (reusableHookBehavior >= 2 && (requestBehavior >= 1 || functionBehavior >= 2) && namedBehavior >= 5)
    || (functionBehavior >= 2 && reactivityBehavior >= 1 && namedBehavior >= 4);
}

function behaviorReason(parts: {
  sharedComposables: readonly string[];
  sharedStores: readonly string[];
  sharedRequests: readonly string[];
  sharedLifecycle: readonly string[];
  sharedFunctions: readonly string[];
  sharedFunctionVerbs: readonly string[];
  sharedBindings: readonly string[];
}): string {
  const reasons: string[] = [];
  if (parts.sharedComposables.length) reasons.push(`shared composables: ${parts.sharedComposables.join(', ')}`);
  if (parts.sharedStores.length) reasons.push(`shared stores: ${parts.sharedStores.join(', ')}`);
  if (parts.sharedRequests.length) reasons.push(`shared request helpers: ${parts.sharedRequests.join(', ')}`);
  if (parts.sharedLifecycle.length) reasons.push(`shared lifecycle: ${parts.sharedLifecycle.join(', ')}`);
  if (parts.sharedFunctions.length) reasons.push(`shared functions: ${parts.sharedFunctions.slice(0, 6).join(', ')}`);
  if (parts.sharedFunctionVerbs.length) reasons.push(`shared action verbs: ${parts.sharedFunctionVerbs.slice(0, 6).join(', ')}`);
  if (parts.sharedBindings.length) reasons.push(`shared template bindings: ${parts.sharedBindings.slice(0, 6).join(', ')}`);
  return reasons.join('; ') || 'shared Vue behavior profile';
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
