import { difference, intersection, jaccard } from '../../analysis/similarity.js';
import { frontendBehaviorProduct } from '../../source/frontend-behavior-products.js';
import type { ReactComponentBehaviorProfile } from '../../source/react-profile.js';
import type { ScipDatabase } from '../../storage/db.js';
import {
  classifyFrontendBehaviorEvidence,
  compareNamedFrontendPairs,
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
  tokenCountA: number;
  tokenCountB: number;
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
  /** Structural relationship between the two files (route entries, intercepting routes, kit primitives). */
  pairContext: FrontendPairContext;
  uniqueToA: string[];
  uniqueToB: string[];
  locA: number;
  locB: number;
}

export interface ReactComponentDuplicateScan {
  results: ReactComponentDuplicateResult[];
  /** Rows the role policy removed before ranking, disclosed by reason. */
  exclusions: FrontendPolicyExclusion[];
}

export interface ReactComponentDuplicateOptions {
  minSimilarity?: number;
  minTokens?: number;
  limit?: number;
  scope?: string;
  scanLimit?: number;
  filePattern?: string;
  focusFiles?: ReadonlySet<string>;
}

interface ReactComponentPairwiseProfile extends PairwiseFileProfile {
  file: string;
  component: string;
  tokens: Set<string>;
  profile: ReactComponentBehaviorProfile;
}

export function reactComponentDuplicates(
  db: ScipDatabase,
  opts: ReactComponentDuplicateOptions = {},
): ReactComponentDuplicateResult[] {
  return reactComponentDuplicateScan(db, opts).results;
}

/**
 * Duplicate-structure scan with its policy exclusions. Test-file components
 * are fixture scaffolding and never enter the comparison; a pair of vendored
 * UI-kit primitives is similar by construction and is dropped after it would
 * otherwise have matched, so the disclosed count reflects real omissions.
 */
export function reactComponentDuplicateScan(
  db: ScipDatabase,
  opts: ReactComponentDuplicateOptions = {},
): ReactComponentDuplicateScan {
  const { minSimilarity = 0.62, minTokens = 8, limit = 20, scope, scanLimit, filePattern, focusFiles } = opts;
  const policy = frontendProfileRolePolicy(db);
  const exclusions = new FrontendPolicyExclusions();
  const profiles = frontendBehaviorProduct(db)
    .reactProfiles({
      scope,
      minJsxTokens: minTokens,
      scanLimit,
    })
    .filter((profile) => profile.kind === 'component')
    .filter((profile) => {
      if (policy.roleOf(profile.file) !== 'test') return true;
      exclusions.record('test-files', FRONTEND_EXCLUSION_DETAILS.testFiles);
      return false;
    })
    .map((profile) => ({
      file: profile.file,
      component: profile.name,
      tokens: profile.jsxTokens,
      profile,
    }));
  const candidateIndex = pairwiseCandidateIndexFromKeys(profiles, (profile) => profile.tokens);

  const results = rankedPairwiseProfileResults({
    profiles,
    limit,
    filePattern,
    focusFiles,
    candidateIndex,
    profile: { name: 'react-component-duplicates' },
    compare: (a, b) => {
      const context = policy.pairContext(a.file, b.file);
      const result = compareReactComponentProfiles(a, b, minSimilarity, context);
      if (!result) return null;
      if (context === 'ui-kit-pair') {
        exclusions.record('ui-kit-pairs', FRONTEND_EXCLUSION_DETAILS.uiKitPairs);
        return null;
      }
      return result;
    },
    sort: compareNamedFrontendPairs,
  });
  return { results, exclusions: exclusions.list() };
}

// scip-query: ignore-extract — reviewed E1 workflow owner; overlap gate, similarity, evidence class, and pair-context policy are one pair verdict.
function compareReactComponentProfiles(
  a: ReactComponentPairwiseProfile,
  b: ReactComponentPairwiseProfile,
  minSimilarity: number,
  pairContext: FrontendPairContext,
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
  const contextReason = pairContextReason(pairContext);
  const placeholderReason = loadingPlaceholderReason(a.component, b.component, sharedComponents);
  const verdict = placeholderReason
    ? { actionTier: 'support' as const, recommendation: LOADING_PLACEHOLDER_RECOMMENDATION }
    : pairContextVerdict(pairContext, evidence.actionTier, evidence.recommendation);
  const reasons = [contextReason, placeholderReason].filter((reason): reason is string => reason !== null);

  return {
    fileA: a.file,
    componentA: a.component,
    fileB: b.file,
    componentB: b.component,
    similarity,
    tokenCountA: a.tokens.size,
    tokenCountB: b.tokens.size,
    sharedTokens: sortedTokens(shared),
    sharedComponents,
    sharedNativeTags,
    sharedProps,
    sharedEvents,
    sharedBindings,
    evidenceClass: evidence.evidenceClass,
    actionTier: verdict.actionTier,
    evidenceClassReasons: [...reasons, ...evidence.reasons],
    recommendation: verdict.recommendation,
    pairContext,
    uniqueToA: sortedTokens(difference(a.tokens, b.tokens)),
    uniqueToB: sortedTokens(difference(b.tokens, a.tokens)),
    locA: a.profile.loc,
    locB: b.profile.loc,
  };
}

function pairContextVerdict(
  pairContext: FrontendPairContext,
  actionTier: FrontendBehaviorActionTier,
  recommendation: string,
): { actionTier: FrontendBehaviorActionTier; recommendation: string } {
  switch (pairContext) {
    case 'framework-route-pair':
      return {
        actionTier: 'support',
        recommendation:
          'Framework route entries share routing scaffolding by design; consolidate only a repeated non-routing body, and keep each route file as the framework entry.',
      };
    case 'intercepting-route-pair':
      return {
        actionTier,
        recommendation:
          'Render one shared view component from both the intercepting route and its target route; the routes are meant to show the same content, not to duplicate its body.',
      };
    case 'ui-kit-pair':
    case 'product':
      return { actionTier, recommendation };
  }
}

/**
 * Two loading placeholders (`TableSkeleton`, `ResultsSkeleton`, ...) that
 * share nothing but the `Skeleton` primitive are per-surface stand-ins whose
 * shape follows the surface they cover; their similarity is the primitive's,
 * not a copied component. Kept visible as support evidence.
 */
function loadingPlaceholderReason(
  componentA: string,
  componentB: string,
  sharedComponents: readonly string[],
): string | null {
  if (!LOADING_PLACEHOLDER_NAME.test(componentA) || !LOADING_PLACEHOLDER_NAME.test(componentB)) return null;
  if (!sharedComponents.every((name) => LOADING_PLACEHOLDER_PRIMITIVES.has(name))) return null;
  return 'both components are loading placeholders sharing only skeleton primitives';
}

const LOADING_PLACEHOLDER_NAME = /(?:Skeleton|Loading|Placeholder|Fallback)(?:[A-Z][A-Za-z0-9]*)?$|^Loading[A-Z]/;
const LOADING_PLACEHOLDER_PRIMITIVES = new Set(['Skeleton', 'Spinner', 'Loader', 'Loader2', 'Placeholder']);
const LOADING_PLACEHOLDER_RECOMMENDATION =
  'Loading placeholders mirror the surface they stand in for; share a skeleton primitive only if the covered layouts are themselves shared.';

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
