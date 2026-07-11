import { difference, intersection, jaccard } from '../../analysis/similarity.js';
import { frontendBehaviorProduct } from '../../source/frontend-behavior-products.js';
import type { VueComponentBehaviorProfile } from '../../source/vue/vue-profile.js';
import type { ScipDatabase } from '../../storage/db.js';
import {
  classifyFrontendBehaviorEvidence,
  overlapGate,
  sortedTokens,
  tokenValues,
  type FrontendBehaviorActionTier,
  type FrontendBehaviorEvidenceClass,
} from '../internal/frontend-behavior-evidence.js';
import {
  pairwiseCandidateIndexFromKeys,
  rankedPairwiseProfileResults,
  type PairwiseFileProfile,
} from '../internal/pairwise-profiles.js';

export interface VueComponentDuplicateResult {
  fileA: string;
  fileB: string;
  similarity: number;
  tokenCountA: number;
  tokenCountB: number;
  sharedTokens: string[];
  sharedComponents: string[];
  sharedProps: string[];
  sharedEvents: string[];
  sharedDirectives: string[];
  sharedSlots: string[];
  sharedIdentifiers: string[];
  evidenceClass: FrontendBehaviorEvidenceClass;
  actionTier: FrontendBehaviorActionTier;
  evidenceClassReasons: string[];
  recommendation: string;
  uniqueToA: string[];
  uniqueToB: string[];
  locA: number;
  locB: number;
}

interface VueComponentProfile extends PairwiseFileProfile {
  file: string;
  tokens: Set<string>;
  loc: number;
}

/**
 * Find Vue SFCs with similar template structure. This catches copy-paste UI
 * variants that function/callee similarity cannot see because the duplicated
 * work lives in component tags, bindings, slots, and directives.
 */
export function vueComponentDuplicates(
  db: ScipDatabase,
  opts: {
    minSimilarity?: number;
    minTokens?: number;
    limit?: number;
    scope?: string;
    scanLimit?: number;
    filePattern?: string;
    focusFiles?: ReadonlySet<string>;
  } = {},
): VueComponentDuplicateResult[] {
  const { minSimilarity = 0.62, minTokens = 8, limit = 20, scope, scanLimit, filePattern, focusFiles } = opts;
  const profiles = buildVueComponentProfiles(db, { scope, minTokens, scanLimit });
  const candidateIndex = pairwiseCandidateIndexFromKeys(profiles, (profile) => profile.tokens);
  return rankedPairwiseProfileResults({
    profiles,
    limit,
    filePattern,
    focusFiles,
    candidateIndex,
    profile: { name: 'vue-component-duplicates' },
    compare: (a, b) => compareVueComponentProfiles(a, b, minSimilarity),
    sort: (a, b) => b.similarity - a.similarity || a.fileA.localeCompare(b.fileA) || a.fileB.localeCompare(b.fileB),
  });
}

function buildVueComponentProfiles(
  db: ScipDatabase,
  opts: { scope?: string; minTokens: number; scanLimit?: number },
): VueComponentProfile[] {
  return frontendBehaviorProduct(db)
    .vueProfiles({
      scope: opts.scope,
      minTemplateTokens: opts.minTokens,
      scanLimit: opts.scanLimit,
    })
    .map((profile) => ({
      file: profile.file,
      tokens: profile.templateTokens,
      loc: vueProfileLoc(profile),
    }));
}

function vueProfileLoc(profile: VueComponentBehaviorProfile): number {
  return profile.totalLines;
}

// scip-query: ignore-similar - Vue comparison mirrors React comparison while preserving framework-specific overlap rules.
function compareVueComponentProfiles(
  a: VueComponentProfile,
  b: VueComponentProfile,
  minSimilarity: number,
): VueComponentDuplicateResult | null {
  const shared = intersection(a.tokens, b.tokens);
  if (shared.size < 6) return null;
  if (!hasMeaningfulVueOverlap(shared)) return null;
  const similarity = jaccard(a.tokens, b.tokens);
  if (similarity < minSimilarity) return null;
  const sharedComponents = tokenValues(shared, 'component:');
  const sharedProps = tokenValues(shared, 'prop:');
  const sharedEvents = tokenValues(shared, 'event:');
  const sharedDirectives = tokenValues(shared, 'directive:');
  const sharedSlots = tokenValues(shared, 'slot:');
  const sharedIdentifiers = tokenValues(shared, 'id:');
  const evidence = classifyVueComponentEvidence({
    sharedComponents,
    sharedProps,
    sharedEvents,
    sharedDirectives,
    sharedSlots,
    sharedIdentifiers,
  });

  return {
    fileA: a.file,
    fileB: b.file,
    similarity,
    tokenCountA: a.tokens.size,
    tokenCountB: b.tokens.size,
    sharedTokens: sortedTokens(shared),
    sharedComponents,
    sharedProps,
    sharedEvents,
    sharedDirectives,
    sharedSlots,
    sharedIdentifiers,
    evidenceClass: evidence.evidenceClass,
    actionTier: evidence.actionTier,
    evidenceClassReasons: evidence.reasons,
    recommendation: evidence.recommendation,
    uniqueToA: sortedTokens(difference(a.tokens, b.tokens)).slice(0, 25),
    uniqueToB: sortedTokens(difference(b.tokens, a.tokens)).slice(0, 25),
    locA: a.loc,
    locB: b.loc,
  };
}

function hasMeaningfulVueOverlap(shared: ReadonlySet<string>): boolean {
  let componentLike = 0;
  let behaviorLike = 0;
  for (const token of shared) {
    if (token.startsWith('component:')) componentLike += 1;
    if (
      token.startsWith('prop:') ||
      token.startsWith('event:') ||
      token.startsWith('directive:') ||
      token.startsWith('slot:')
    ) {
      behaviorLike += 1;
    }
  }
  return overlapGate(
    [
      { name: 'component', count: componentLike },
      { name: 'behavior', count: behaviorLike },
    ],
    [
      { min: { component: 1 }, reason: 'shared custom component' },
      { min: { behavior: 3 }, reason: 'shared Vue template structure' },
    ],
  ).pass;
}

function classifyVueComponentEvidence(parts: {
  sharedComponents: readonly string[];
  sharedProps: readonly string[];
  sharedEvents: readonly string[];
  sharedDirectives: readonly string[];
  sharedSlots: readonly string[];
  sharedIdentifiers: readonly string[];
}) {
  return classifyFrontendBehaviorEvidence({
    genericWords: GENERIC_VUE_STRUCTURE_WORDS,
    primitiveGroups: [
      { values: parts.sharedProps, reasonPrefix: 'shared props', bucket: 'generic' },
      { values: parts.sharedEvents, reasonPrefix: 'shared events', bucket: 'generic' },
      { values: parts.sharedDirectives, reasonPrefix: 'shared directives', bucket: 'generic' },
      { values: parts.sharedSlots, reasonPrefix: 'shared slots', bucket: 'generic' },
    ],
    nameGroups: [
      { names: parts.sharedComponents, label: 'shared component', fallbackBucket: 'generic' },
      { names: parts.sharedIdentifiers, label: 'shared identifier', fallbackBucket: 'generic' },
    ],
    recommendation: vueComponentRecommendation,
  });
}

function vueComponentRecommendation(evidenceClass: FrontendBehaviorEvidenceClass): string {
  switch (evidenceClass) {
    case 'domain-behavior':
    case 'mixed':
      return 'Review for a shared component or feature-specific Vue primitive around the named domain structure.';
    case 'shared-abstraction':
      return 'Review the existing shared component usage first; extract only if duplicated structure remains outside it.';
    case 'generic-workflow-scaffolding':
      return 'Generic structural overlap — verify intent before consolidating.';
  }
}

const GENERIC_VUE_STRUCTURE_WORDS = new Set([
  'actions',
  'app',
  'button',
  'card',
  'content',
  'container',
  'dialog',
  'field',
  'form',
  'header',
  'input',
  'item',
  'label',
  'layout',
  'list',
  'modal',
  'page',
  'panel',
  'row',
  'section',
  'shell',
  'table',
  'text',
  'toolbar',
  'ui',
  'value',
  'view',
  'wrapper',
]);
