import { difference, intersection, jaccard } from '../../analysis/similarity.js';
import { buildVueComponentBehaviorProfiles, type VueComponentBehaviorProfile } from '../../source/vue/vue-profile.js';
import type { ScipDatabase } from '../../storage/db.js';
import { rankedPairwiseProfileResults, type PairwiseFileProfile } from '../internal/pairwise-profiles.js';

export type VueComposableEvidenceClass =
  | 'domain-behavior'
  | 'generic-workflow-scaffolding'
  | 'mixed'
  | 'shared-abstraction';
export type VueComposableActionTier = 'signal' | 'support';

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
  evidenceClass: VueComposableEvidenceClass;
  actionTier: VueComposableActionTier;
  evidenceClassReasons: string[];
  recommendation: string;
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
  const { minSimilarity = 0.45, minSharedBehaviors = 6, limit = 20, scope, scanLimit, filePattern } = opts;
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
    sort: (a, b) => b.similarity - a.similarity || a.fileA.localeCompare(b.fileA) || a.fileB.localeCompare(b.fileB),
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
  const evidence = classifyVueComposableEvidence({
    sharedComposables,
    sharedStores,
    sharedReactivity,
    sharedLifecycle,
    sharedRequests,
    sharedFunctions,
    sharedFunctionVerbs,
    sharedBindings,
    sharedTemplateEvents,
  });

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
    evidenceClass: evidence.evidenceClass,
    actionTier: evidence.actionTier,
    evidenceClassReasons: evidence.reasons,
    recommendation: evidence.recommendation,
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

function classifyVueComposableEvidence(parts: {
  sharedComposables: readonly string[];
  sharedStores: readonly string[];
  sharedReactivity: readonly string[];
  sharedLifecycle: readonly string[];
  sharedRequests: readonly string[];
  sharedFunctions: readonly string[];
  sharedFunctionVerbs: readonly string[];
  sharedBindings: readonly string[];
  sharedTemplateEvents: readonly string[];
}): {
  actionTier: VueComposableActionTier;
  evidenceClass: VueComposableEvidenceClass;
  recommendation: string;
  reasons: string[];
} {
  const domainReasons: string[] = [];
  const genericReasons: string[] = [];
  const sharedAbstractionReasons: string[] = [];

  if (parts.sharedReactivity.length) {
    genericReasons.push(`shared reactivity primitive: ${parts.sharedReactivity.join(', ')}`);
  }
  if (parts.sharedLifecycle.length) {
    genericReasons.push(`shared lifecycle primitive: ${parts.sharedLifecycle.join(', ')}`);
  }
  classifyNames(parts.sharedComposables, 'shared composable', domainReasons, sharedAbstractionReasons);
  classifyNames(parts.sharedStores, 'shared store', domainReasons, sharedAbstractionReasons);
  classifyNames(parts.sharedRequests, 'shared request', domainReasons, genericReasons);
  classifyNames(parts.sharedFunctions, 'shared function', domainReasons, genericReasons);
  classifyNames(parts.sharedFunctionVerbs, 'shared action verb', domainReasons, genericReasons);
  classifyNames(parts.sharedBindings, 'shared binding', domainReasons, genericReasons);
  classifyNames(parts.sharedTemplateEvents, 'shared template event', domainReasons, genericReasons);

  const hasDomain = domainReasons.length > 0;
  const hasGeneric = genericReasons.length > 0;
  const hasSharedAbstraction = sharedAbstractionReasons.length > 0;
  const evidenceClass: VueComposableEvidenceClass = hasDomain
    ? hasGeneric || hasSharedAbstraction
      ? 'mixed'
      : 'domain-behavior'
    : hasSharedAbstraction
      ? 'shared-abstraction'
      : 'generic-workflow-scaffolding';
  const actionTier: VueComposableActionTier =
    evidenceClass === 'domain-behavior' || evidenceClass === 'mixed' ? 'signal' : 'support';
  return {
    actionTier,
    evidenceClass,
    reasons: [...domainReasons, ...sharedAbstractionReasons, ...genericReasons].slice(0, 6),
    recommendation: vueComposableRecommendation(evidenceClass),
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
  const words = behaviorWords(name).filter((word) => !GENERIC_VUE_BEHAVIOR_WORDS.has(word));
  return words.length > 0;
}

function behaviorWords(name: string): string[] {
  return name
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function vueComposableRecommendation(evidenceClass: VueComposableEvidenceClass): string {
  switch (evidenceClass) {
    case 'domain-behavior':
      return 'Review for a shared composable, store, or feature module around the named domain behavior.';
    case 'mixed':
      return 'Separate generic Vue mechanics from domain-specific behavior before extracting a composable.';
    case 'shared-abstraction':
      return 'Review the existing composable/store usage first; extract only if duplicated behavior remains outside it.';
    case 'generic-workflow-scaffolding':
      return 'Treat as support evidence for a repeated workflow shape, not direct composable-extraction evidence.';
  }
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
      token.startsWith('function-verb:') ||
      token.startsWith('template-binding:') ||
      token.startsWith('template-event:')
    ) {
      supportingBehavior += 1;
    }
  }
  const reusableHookBehavior = composableBehavior + storeBehavior;
  const namedBehavior =
    reusableHookBehavior + requestBehavior + lifecycleBehavior + functionBehavior + supportingBehavior;
  return (
    (requestBehavior >= 1 && namedBehavior >= 4) ||
    (lifecycleBehavior >= 1 && functionBehavior >= 2 && namedBehavior >= 4) ||
    (reusableHookBehavior >= 2 && (requestBehavior >= 1 || functionBehavior >= 2) && namedBehavior >= 5) ||
    (functionBehavior >= 2 && reactivityBehavior >= 1 && namedBehavior >= 4)
  );
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
  if (parts.sharedFunctionVerbs.length)
    reasons.push(`shared action verbs: ${parts.sharedFunctionVerbs.slice(0, 6).join(', ')}`);
  if (parts.sharedBindings.length)
    reasons.push(`shared template bindings: ${parts.sharedBindings.slice(0, 6).join(', ')}`);
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

const GENERIC_VUE_BEHAVIOR_WORDS = new Set([
  'add',
  'apply',
  'cancel',
  'change',
  'clear',
  'close',
  'composable',
  'create',
  'data',
  'delete',
  'draft',
  'edit',
  'error',
  'fetch',
  'filter',
  'form',
  'item',
  'items',
  'load',
  'loading',
  'name',
  'open',
  'reactive',
  'ref',
  'refresh',
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
  'store',
  'submit',
  'toggle',
  'update',
  'use',
  'value',
  'watch',
]);
