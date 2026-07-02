import { frontendBehaviorProduct } from '../../source/frontend-behavior-products.js';
import type { VueComponentBehaviorProfile } from '../../source/vue/vue-profile.js';
import type { ScipDatabase } from '../../storage/db.js';
import { evaluatePressure, type PressureAxis } from '../internal/frontend-behavior-evidence.js';

export type VueLargeViewPressureAxis = 'template' | 'script' | 'style' | 'external-script' | 'custom-block' | 'total';
export type VueLargeViewContextKind = 'component' | 'route-page';
export type VueLargeViewRecommendationKind =
  | 'custom-block-review'
  | 'external-script-boundary'
  | 'route-page-decomposition'
  | 'script-behavior-extraction'
  | 'style-decomposition'
  | 'template-decomposition'
  | 'total-size-review';

export interface VueLargeViewPressureResult {
  file: string;
  /** Component/SFC + external-script lines, plus one hop of delegated `use*` composable LOC. */
  totalLines: number;
  sfcLines: number;
  templateLines: number;
  scriptLines: number;
  styleLines: number;
  externalScriptLines: number;
  externalScriptPaths: string[];
  customBlockLines: number;
  /** LOC of imported `use*` composables this view's script actually invokes (one hop, not recursed). */
  delegatedComposableLines: number;
  delegatedComposablePaths: string[];
  dominantPressure: VueLargeViewPressureAxis;
  pressureKinds: VueLargeViewPressureAxis[];
  contextKind: VueLargeViewContextKind;
  recommendationKind: VueLargeViewRecommendationKind;
  recommendation: string;
  reasons: string[];
  loc: number;
}

export function vueLargeViewPressure(
  db: ScipDatabase,
  opts: {
    minTotalLines?: number;
    minTemplateLines?: number;
    minScriptLines?: number;
    minStyleLines?: number;
    limit?: number;
    scope?: string;
    scanLimit?: number;
    filePattern?: string;
  } = {},
): VueLargeViewPressureResult[] {
  const {
    minTotalLines = 800,
    minTemplateLines = 300,
    minScriptLines = 300,
    minStyleLines = 500,
    limit = 20,
    scope,
    scanLimit,
    filePattern,
  } = opts;
  const profiles = frontendBehaviorProduct(db)
    .vueProfiles({ scope, scanLimit })
    .filter((profile) => !filePattern || profile.file.includes(filePattern));
  return profiles
    .map((profile) =>
      pressureResult(profile, {
        minTotalLines,
        minTemplateLines,
        minScriptLines,
        minStyleLines,
      }),
    )
    .filter((result): result is VueLargeViewPressureResult => result !== null)
    .sort((a, b) => b.totalLines - a.totalLines || a.file.localeCompare(b.file))
    .slice(0, limit);
}

function pressureResult(
  profile: VueComponentBehaviorProfile,
  thresholds: {
    minTotalLines: number;
    minTemplateLines: number;
    minScriptLines: number;
    minStyleLines: number;
  },
): VueLargeViewPressureResult | null {
  const pressure = evaluatePressure(profile, vuePressureAxes(thresholds), 'total');
  const { reasons } = pressure;
  if (reasons.length === 0) return null;

  const dominant = pressure.dominantPressure;
  const pressureKinds = pressure.pressureKinds.includes('total')
    ? [...new Set([...pressure.pressureKinds, dominant])]
    : pressure.pressureKinds;
  const contextKind = vueContextKind(profile.file);
  const recommendationKind = recommendationKindFor(dominant, contextKind);
  const totalLines = profile.totalLines + profile.delegatedComposableLines;
  return {
    file: profile.file,
    totalLines,
    sfcLines: profile.sfcLines,
    templateLines: profile.templateLines,
    scriptLines: profile.scriptLines,
    styleLines: profile.styleLines,
    externalScriptLines: profile.externalScriptLines,
    externalScriptPaths: profile.externalScriptPaths,
    customBlockLines: profile.customBlockLines,
    delegatedComposableLines: profile.delegatedComposableLines,
    delegatedComposablePaths: profile.delegatedComposablePaths,
    dominantPressure: dominant,
    pressureKinds,
    contextKind,
    recommendationKind,
    recommendation: recommendationFor(recommendationKind, contextKind),
    reasons,
    loc: totalLines,
  };
}

function vuePressureAxes(thresholds: {
  minTotalLines: number;
  minTemplateLines: number;
  minScriptLines: number;
  minStyleLines: number;
}): PressureAxis<VueComponentBehaviorProfile, VueLargeViewPressureAxis>[] {
  return [
    {
      axis: 'total',
      value: (profile) => profile.totalLines + profile.delegatedComposableLines,
      qualifies: (_profile, value) => value >= thresholds.minTotalLines,
      reason: (profile, value) =>
        profile.delegatedComposableLines > 0
          ? `${value} total line(s) (${profile.totalLines} component + ${profile.delegatedComposableLines} delegated composable line(s) across ${profile.delegatedComposablePaths.length} file(s))`
          : `${value} total component line(s)`,
      dominantEligible: false,
    },
    {
      axis: 'template',
      value: (profile) => profile.templateLines,
      qualifies: (_profile, value) => value >= thresholds.minTemplateLines,
      reason: (_profile, value) => `${value} template line(s)`,
    },
    {
      axis: 'script',
      value: (profile) => profile.scriptLines - profile.externalScriptLines,
      qualifies: (profile) => profile.scriptLines >= thresholds.minScriptLines,
      reason: (profile) => `${profile.scriptLines} script line(s)`,
    },
    {
      axis: 'style',
      value: (profile) => profile.styleLines,
      qualifies: (_profile, value) => value >= thresholds.minStyleLines,
      reason: (_profile, value) => `${value} style line(s)`,
    },
    {
      axis: 'external-script',
      value: (profile) => profile.externalScriptLines,
      qualifies: (_profile, value) => value >= thresholds.minScriptLines,
    },
    {
      axis: 'custom-block',
      value: (profile) => profile.customBlockLines,
      qualifies: () => false,
    },
  ];
}

function vueContextKind(file: string): VueLargeViewContextKind {
  const lower = file.toLowerCase();
  const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean);
  if (
    tokens.some((token) => ROUTE_PAGE_TOKENS.has(token)) ||
    /(?:view|page|route)\.vue$/i.test(file) ||
    /(?:^|\/)(views|pages|routes)\//i.test(file)
  ) {
    return 'route-page';
  }
  return 'component';
}

function recommendationKindFor(
  dominant: VueLargeViewPressureAxis,
  contextKind: VueLargeViewContextKind,
): VueLargeViewRecommendationKind {
  if (dominant === 'style') return 'style-decomposition';
  if (dominant === 'template') return 'template-decomposition';
  if (dominant === 'external-script') return 'external-script-boundary';
  if (dominant === 'custom-block') return 'custom-block-review';
  if (contextKind === 'route-page') return 'route-page-decomposition';
  if (dominant === 'script') return 'script-behavior-extraction';
  return 'total-size-review';
}

function recommendationFor(
  recommendationKind: VueLargeViewRecommendationKind,
  contextKind: VueLargeViewContextKind,
): string {
  switch (recommendationKind) {
    case 'template-decomposition':
      return contextKind === 'route-page'
        ? 'Split route template sections into named panels before extracting script behavior.'
        : 'Split repeated template sections into named presentational components.';
    case 'script-behavior-extraction':
      return 'Extract independent script behavior into composables, controllers, or feature modules.';
    case 'style-decomposition':
      return 'Review UI/style decomposition; move repeated styling to component or style primitives, not composables.';
    case 'external-script-boundary':
      return 'Review the external script boundary and split controller/composable modules by workflow.';
    case 'custom-block-review':
      return 'Review custom block ownership before splitting template or script code.';
    case 'route-page-decomposition':
      return 'Split route/page orchestration from reusable panels and feature controllers.';
    case 'total-size-review':
      return 'Review the largest block first, then split by the dominant reason to change.';
  }
}

const ROUTE_PAGE_TOKENS = new Set(['landing', 'page', 'pages', 'route', 'routes', 'view', 'views']);
