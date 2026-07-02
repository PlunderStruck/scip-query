import { difference, intersection, jaccard } from '../../analysis/similarity.js';
import { frontendBehaviorProduct } from '../../source/frontend-behavior-products.js';
import type { ReactComponentBehaviorProfile } from '../../source/react-profile.js';
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
  evidenceClass: FrontendBehaviorEvidenceClass;
  actionTier: FrontendBehaviorActionTier;
  evidenceClassReasons: string[];
  recommendation: string;
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
    focusFiles?: ReadonlySet<string>;
  } = {},
): ReactComponentDuplicateResult[] {
  const { minSimilarity = 0.62, minTokens = 8, limit = 20, scope, scanLimit, filePattern, focusFiles } = opts;
  const profiles = frontendBehaviorProduct(db)
    .reactProfiles({
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
  const candidateIndex = pairwiseCandidateIndexFromKeys(profiles, (profile) => profile.tokens);

  return rankedPairwiseProfileResults({
    profiles,
    limit,
    filePattern,
    focusFiles,
    candidateIndex,
    profile: { name: 'react-component-duplicates' },
    compare: (a, b) => compareReactComponentProfiles(a, b, minSimilarity),
    sort: (a, b) =>
      b.similarity - a.similarity ||
      a.fileA.localeCompare(b.fileA) ||
      a.componentA.localeCompare(b.componentA) ||
      a.fileB.localeCompare(b.fileB) ||
      a.componentB.localeCompare(b.componentB),
  });
}

function compareReactComponentProfiles(
  a: ReactComponentPairwiseProfile,
  b: ReactComponentPairwiseProfile,
  minSimilarity: number,
): ReactComponentDuplicateResult | null {
  const shared = intersection(a.tokens, b.tokens);
  if (shared.size < 6) return null;
  if (!hasMeaningfulReactStructureOverlap(shared)) return null;
  const similarity = jaccard(a.tokens, b.tokens);
  if (similarity < minSimilarity) return null;
  const sharedComponents = tokenValues(shared, 'component:');
  const sharedNativeTags = tokenValues(shared, 'native:');
  const sharedProps = tokenValues(shared, 'prop:');
  const sharedEvents = tokenValues(shared, 'event:');
  const sharedBindings = tokenValues(shared, 'binding:');
  const evidence = classifyReactComponentEvidence({
    sharedComponents,
    sharedNativeTags,
    sharedProps,
    sharedEvents,
    sharedBindings,
  });

  return {
    fileA: a.file,
    componentA: a.component,
    fileB: b.file,
    componentB: b.component,
    similarity,
    sharedTokens: sortedTokens(shared),
    sharedComponents,
    sharedNativeTags,
    sharedProps,
    sharedEvents,
    sharedBindings,
    evidenceClass: evidence.evidenceClass,
    actionTier: evidence.actionTier,
    evidenceClassReasons: evidence.reasons,
    recommendation: evidence.recommendation,
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
  return overlapGate(
    [
      { name: 'component', count: componentLike },
      { name: 'shape', count: shapeLike },
    ],
    [
      { min: { component: 1 }, reason: 'shared custom component' },
      { min: { shape: 4 }, reason: 'shared JSX structure' },
    ],
  ).pass;
}

function classifyReactComponentEvidence(parts: {
  sharedComponents: readonly string[];
  sharedNativeTags: readonly string[];
  sharedProps: readonly string[];
  sharedEvents: readonly string[];
  sharedBindings: readonly string[];
}) {
  return classifyFrontendBehaviorEvidence({
    genericWords: GENERIC_REACT_STRUCTURE_WORDS,
    primitiveGroups: [
      { values: parts.sharedNativeTags, reasonPrefix: 'shared native tags', bucket: 'generic' },
      { values: parts.sharedProps, reasonPrefix: 'shared props', bucket: 'generic' },
      { values: parts.sharedEvents, reasonPrefix: 'shared events', bucket: 'generic' },
    ],
    nameGroups: [
      { names: parts.sharedComponents, label: 'shared component', fallbackBucket: 'generic' },
      { names: parts.sharedBindings, label: 'shared binding', fallbackBucket: 'generic' },
    ],
    recommendation: reactComponentRecommendation,
  });
}

function reactComponentRecommendation(evidenceClass: FrontendBehaviorEvidenceClass): string {
  switch (evidenceClass) {
    case 'domain-behavior':
    case 'mixed':
      return 'Review for a shared component or feature-specific UI primitive around the named domain structure.';
    case 'shared-abstraction':
      return 'Review the existing shared component usage first; extract only if duplicated structure remains outside it.';
    case 'generic-workflow-scaffolding':
      return 'Generic structural overlap — verify intent before consolidating.';
  }
}

const GENERIC_REACT_STRUCTURE_WORDS = new Set([
  'actions',
  'app',
  'button',
  'card',
  'children',
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
