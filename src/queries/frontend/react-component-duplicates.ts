import { difference, intersection, jaccard } from '../../analysis/similarity.js';
import { buildReactComponentBehaviorProfiles, type ReactComponentBehaviorProfile } from '../../source/react-profile.js';
import type { ScipDatabase } from '../../storage/db.js';
import { sortedTokens, tokenValues } from '../internal/frontend-behavior-evidence.js';
import { rankedPairwiseProfileResults, type PairwiseFileProfile } from '../internal/pairwise-profiles.js';

export interface ReactComponentDuplicateResult {
  fileA: string;
  componentA: string;
  fileB: string;
  componentB: string;
  similarity: number;
  sharedTokens: string[];
  sharedComponents: string[];
  sharedNativeTags: string[];
  sharedProps: string[];
  sharedEvents: string[];
  sharedBindings: string[];
  uniqueToA: string[];
  uniqueToB: string[];
  locA: number;
  locB: number;
}

interface ReactComponentPairwiseProfile extends PairwiseFileProfile {
  file: string;
  component: string;
  tokens: Set<string>;
  profile: ReactComponentBehaviorProfile;
}

export function reactComponentDuplicates(
  db: ScipDatabase,
  opts: {
    minSimilarity?: number;
    minTokens?: number;
    limit?: number;
    scope?: string;
    scanLimit?: number;
    filePattern?: string;
  } = {},
): ReactComponentDuplicateResult[] {
  const { minSimilarity = 0.62, minTokens = 8, limit = 20, scope, scanLimit, filePattern } = opts;
  const profiles = buildReactComponentBehaviorProfiles(db, {
    scope,
    minJsxTokens: minTokens,
    scanLimit,
  })
    .filter((profile) => profile.kind === 'component')
    .map((profile) => ({
      file: profile.file,
      component: profile.name,
      tokens: profile.jsxTokens,
      profile,
    }));

  return rankedPairwiseProfileResults({
    profiles,
    limit,
    filePattern,
    compare: (a, b) => compareProfiles(a, b, minSimilarity),
    sort: (a, b) =>
      b.similarity - a.similarity ||
      a.fileA.localeCompare(b.fileA) ||
      a.componentA.localeCompare(b.componentA) ||
      a.fileB.localeCompare(b.fileB) ||
      a.componentB.localeCompare(b.componentB),
  });
}

function compareProfiles(
  a: ReactComponentPairwiseProfile,
  b: ReactComponentPairwiseProfile,
  minSimilarity: number,
): ReactComponentDuplicateResult | null {
  const shared = intersection(a.tokens, b.tokens);
  if (shared.size < 6) return null;
  if (!hasMeaningfulReactStructureOverlap(shared)) return null;
  const similarity = jaccard(a.tokens, b.tokens);
  if (similarity < minSimilarity) return null;

  return {
    fileA: a.file,
    componentA: a.component,
    fileB: b.file,
    componentB: b.component,
    similarity,
    sharedTokens: sortedTokens(shared),
    sharedComponents: tokenValues(shared, 'component:'),
    sharedNativeTags: tokenValues(shared, 'native:'),
    sharedProps: tokenValues(shared, 'prop:'),
    sharedEvents: tokenValues(shared, 'event:'),
    sharedBindings: tokenValues(shared, 'binding:'),
    uniqueToA: sortedTokens(difference(a.tokens, b.tokens)).slice(0, 25),
    uniqueToB: sortedTokens(difference(b.tokens, a.tokens)).slice(0, 25),
    locA: a.profile.loc,
    locB: b.profile.loc,
  };
}

function hasMeaningfulReactStructureOverlap(shared: ReadonlySet<string>): boolean {
  let componentLike = 0;
  let shapeLike = 0;
  for (const token of shared) {
    if (token.startsWith('component:')) componentLike += 1;
    if (
      token.startsWith('prop:') ||
      token.startsWith('event:') ||
      token.startsWith('native:') ||
      token.startsWith('jsx:')
    ) {
      shapeLike += 1;
    }
  }
  return componentLike >= 1 || shapeLike >= 4;
}
