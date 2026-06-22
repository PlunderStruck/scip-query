import { buildVueComponentBehaviorProfiles, type VueComponentBehaviorProfile } from '../../source/vue/vue-profile.js';
import type { ScipDatabase } from '../../storage/db.js';

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
  totalLines: number;
  sfcLines: number;
  templateLines: number;
  scriptLines: number;
  styleLines: number;
  externalScriptLines: number;
  externalScriptPaths: string[];
  customBlockLines: number;
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
  const profiles = buildVueComponentBehaviorProfiles(db, { scope, scanLimit }).filter(
    (profile) => !filePattern || profile.file.includes(filePattern),
  );
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
  const reasons: string[] = [];
  if (profile.totalLines >= thresholds.minTotalLines) {
    reasons.push(`${profile.totalLines} total component line(s)`);
  }
  if (profile.templateLines >= thresholds.minTemplateLines) {
    reasons.push(`${profile.templateLines} template line(s)`);
  }
  if (profile.scriptLines >= thresholds.minScriptLines) {
    reasons.push(`${profile.scriptLines} script line(s)`);
  }
  if (profile.styleLines >= thresholds.minStyleLines) {
    reasons.push(`${profile.styleLines} style line(s)`);
  }
  if (reasons.length === 0) return null;

  const dominant = dominantPressure(profile);
  const pressureKinds = pressureKindsFor(profile, thresholds, dominant);
  const contextKind = vueContextKind(profile.file);
  const recommendationKind = recommendationKindFor(dominant, contextKind);
  return {
    file: profile.file,
    totalLines: profile.totalLines,
    sfcLines: profile.sfcLines,
    templateLines: profile.templateLines,
    scriptLines: profile.scriptLines,
    styleLines: profile.styleLines,
    externalScriptLines: profile.externalScriptLines,
    externalScriptPaths: profile.externalScriptPaths,
    customBlockLines: profile.customBlockLines,
    dominantPressure: dominant,
    pressureKinds,
    contextKind,
    recommendationKind,
    recommendation: recommendationFor(recommendationKind, contextKind),
    reasons,
    loc: profile.totalLines,
  };
}

function dominantPressure(profile: VueComponentBehaviorProfile): VueLargeViewPressureAxis {
  const entries: Array<{ axis: VueLargeViewPressureAxis; lines: number }> = [
    { axis: 'template', lines: profile.templateLines },
    { axis: 'script', lines: profile.scriptLines - profile.externalScriptLines },
    { axis: 'style', lines: profile.styleLines },
    { axis: 'external-script', lines: profile.externalScriptLines },
    { axis: 'custom-block', lines: profile.customBlockLines },
  ];
  entries.sort((a, b) => b.lines - a.lines);
  return entries[0]?.lines ? entries[0].axis : 'total';
}

function pressureKindsFor(
  profile: VueComponentBehaviorProfile,
  thresholds: {
    minTotalLines: number;
    minTemplateLines: number;
    minScriptLines: number;
    minStyleLines: number;
  },
  dominant: VueLargeViewPressureAxis,
): VueLargeViewPressureAxis[] {
  const kinds: VueLargeViewPressureAxis[] = [];
  if (profile.totalLines >= thresholds.minTotalLines) {
    kinds.push('total');
    if (dominant !== 'total') kinds.push(dominant);
  }
  if (profile.templateLines >= thresholds.minTemplateLines) kinds.push('template');
  if (profile.scriptLines >= thresholds.minScriptLines) kinds.push('script');
  if (profile.styleLines >= thresholds.minStyleLines) kinds.push('style');
  if (profile.externalScriptLines >= thresholds.minScriptLines || dominant === 'external-script') {
    kinds.push('external-script');
  }
  if (profile.customBlockLines > 0 && dominant === 'custom-block') {
    kinds.push('custom-block');
  }
  return [...new Set(kinds.length > 0 ? kinds : [dominant])];
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
