import { difference, intersection, jaccard } from '../../analysis/similarity.js';
import { frontendBehaviorProduct } from '../../source/frontend-behavior-products.js';
import type { VueComponentBehaviorProfile } from '../../source/vue/vue-profile.js';
import type { ScipDatabase } from '../../storage/db.js';
import { sortedTokens, tokenValues } from '../internal/frontend-behavior-evidence.js';
import {
  pairwiseCandidateIndexFromKeys,
  rankedPairwiseProfileResults,
  type PairwiseFileProfile,
} from '../internal/pairwise-profiles.js';

export interface VueComponentDuplicateResult {
  fileA: string;
  fileB: string;
  similarity: number;
  sharedTokens: string[];
  sharedComponents: string[];
  sharedProps: string[];
  sharedEvents: string[];
  sharedDirectives: string[];
  sharedSlots: string[];
  sharedIdentifiers: string[];
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
    compare: (a, b) => compareProfiles(a, b, minSimilarity),
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
function compareProfiles(
  a: VueComponentProfile,
  b: VueComponentProfile,
  minSimilarity: number,
): VueComponentDuplicateResult | null {
  const shared = intersection(a.tokens, b.tokens);
  if (shared.size < 6) return null;
  if (!hasMeaningfulVueOverlap(shared)) return null;
  const similarity = jaccard(a.tokens, b.tokens);
  if (similarity < minSimilarity) return null;

  return {
    fileA: a.file,
    fileB: b.file,
    similarity,
    sharedTokens: sortedTokens(shared),
    sharedComponents: tokenValues(shared, 'component:'),
    sharedProps: tokenValues(shared, 'prop:'),
    sharedEvents: tokenValues(shared, 'event:'),
    sharedDirectives: tokenValues(shared, 'directive:'),
    sharedSlots: tokenValues(shared, 'slot:'),
    sharedIdentifiers: tokenValues(shared, 'id:'),
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
  return componentLike >= 1 || behaviorLike >= 3;
}
