import { buildReactComponentBehaviorProfiles, type ReactComponentBehaviorProfile } from '../../source/react-profile.js';
import type { ScipDatabase } from '../../storage/db.js';

export type ReactLargeComponentPressureAxis = 'component' | 'file' | 'jsx-structure' | 'hook-behavior';
export type ReactLargeComponentContextKind = 'component' | 'route-page';
export type ReactLargeComponentRecommendationKind =
  | 'behavior-extraction'
  | 'component-decomposition'
  | 'file-decomposition'
  | 'jsx-decomposition'
  | 'route-page-decomposition';

export interface ReactLargeComponentPressureResult {
  file: string;
  component: string;
  componentLines: number;
  fileLines: number;
  jsxTokens: number;
  behaviorTokens: number;
  dominantPressure: ReactLargeComponentPressureAxis;
  pressureKinds: ReactLargeComponentPressureAxis[];
  contextKind: ReactLargeComponentContextKind;
  recommendationKind: ReactLargeComponentRecommendationKind;
  recommendation: string;
  reasons: string[];
  loc: number;
}

export function reactLargeComponentPressure(
  db: ScipDatabase,
  opts: {
    minComponentLines?: number;
    minFileLines?: number;
    minJsxTokens?: number;
    minBehaviorTokens?: number;
    limit?: number;
    scope?: string;
    scanLimit?: number;
    filePattern?: string;
  } = {},
): ReactLargeComponentPressureResult[] {
  const {
    minComponentLines = 300,
    minFileLines = 800,
    minJsxTokens = 80,
    minBehaviorTokens = 40,
    limit = 20,
    scope,
    scanLimit,
    filePattern,
  } = opts;
  const profiles = buildReactComponentBehaviorProfiles(db, { scope, scanLimit })
    .filter((profile) => profile.kind === 'component')
    .filter((profile) => !filePattern || profile.file.includes(filePattern) || profile.name.includes(filePattern));
  return profiles
    .map((profile) =>
      pressureResult(profile, {
        minComponentLines,
        minFileLines,
        minJsxTokens,
        minBehaviorTokens,
      }),
    )
    .filter((result): result is ReactLargeComponentPressureResult => result !== null)
    .sort((a, b) => b.componentLines - a.componentLines || b.fileLines - a.fileLines || a.file.localeCompare(b.file))
    .slice(0, limit);
}

function pressureResult(
  profile: ReactComponentBehaviorProfile,
  thresholds: {
    minComponentLines: number;
    minFileLines: number;
    minJsxTokens: number;
    minBehaviorTokens: number;
  },
): ReactLargeComponentPressureResult | null {
  const reasons: string[] = [];
  if (profile.loc >= thresholds.minComponentLines) {
    reasons.push(`${profile.loc} component line(s)`);
  }
  const substantialComponentLines = Math.max(80, Math.floor(thresholds.minComponentLines / 2));
  if (profile.fileLines >= thresholds.minFileLines && profile.loc >= substantialComponentLines) {
    reasons.push(`${profile.fileLines} file line(s)`);
  }
  if (profile.jsxTokens.size >= thresholds.minJsxTokens) {
    reasons.push(`${profile.jsxTokens.size} JSX structure token(s)`);
  }
  if (profile.behaviorTokens.size >= thresholds.minBehaviorTokens) {
    reasons.push(`${profile.behaviorTokens.size} behavior token(s)`);
  }
  if (reasons.length === 0) return null;

  const dominant = dominantPressure(profile);
  const pressureKinds = pressureKindsFor(profile, thresholds, dominant);
  const contextKind = reactContextKind(profile);
  const recommendationKind = recommendationKindFor(dominant, pressureKinds, contextKind);
  return {
    file: profile.file,
    component: profile.name,
    componentLines: profile.loc,
    fileLines: profile.fileLines,
    jsxTokens: profile.jsxTokens.size,
    behaviorTokens: profile.behaviorTokens.size,
    dominantPressure: dominant,
    pressureKinds,
    contextKind,
    recommendationKind,
    recommendation: recommendationFor(recommendationKind, contextKind),
    reasons,
    loc: profile.loc,
  };
}

function dominantPressure(profile: ReactComponentBehaviorProfile): ReactLargeComponentPressureAxis {
  const entries: Array<{ axis: ReactLargeComponentPressureAxis; value: number }> = [
    { axis: 'component', value: profile.loc },
    { axis: 'file', value: profile.fileLines },
    { axis: 'jsx-structure', value: profile.jsxTokens.size * 3 },
    { axis: 'hook-behavior', value: profile.behaviorTokens.size * 4 },
  ];
  entries.sort((a, b) => b.value - a.value);
  return entries[0]?.axis ?? 'component';
}

function pressureKindsFor(
  profile: ReactComponentBehaviorProfile,
  thresholds: {
    minComponentLines: number;
    minFileLines: number;
    minJsxTokens: number;
    minBehaviorTokens: number;
  },
  dominant: ReactLargeComponentPressureAxis,
): ReactLargeComponentPressureAxis[] {
  const kinds: ReactLargeComponentPressureAxis[] = [];
  if (profile.loc >= thresholds.minComponentLines) kinds.push('component');
  const substantialComponentLines = Math.max(80, Math.floor(thresholds.minComponentLines / 2));
  if (profile.fileLines >= thresholds.minFileLines && profile.loc >= substantialComponentLines) kinds.push('file');
  if (profile.jsxTokens.size >= thresholds.minJsxTokens) kinds.push('jsx-structure');
  if (profile.behaviorTokens.size >= thresholds.minBehaviorTokens) kinds.push('hook-behavior');
  return [...new Set(kinds.length > 0 ? kinds : [dominant])];
}

function reactContextKind(profile: ReactComponentBehaviorProfile): ReactLargeComponentContextKind {
  const segments = profile.file.split(/[\\/]+/).filter(Boolean);
  const ownerSegments = segments.slice(0, -1).map((segment) => segment.toLowerCase());
  const baseName = (segments.at(-1) ?? profile.name).replace(/\.[^.]+$/, '');
  const lowerNameTokens = `${baseName} ${profile.name}`
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
  const routeRootIndex = ownerSegments.findIndex((segment) => ROUTE_DIRECTORY_TOKENS.has(segment));
  const nestedLocalComponent =
    routeRootIndex >= 0 &&
    ownerSegments.slice(routeRootIndex + 1).some((segment) => LOCAL_COMPONENT_DIRECTORY_TOKENS.has(segment));
  const componentNamed = componentNameLooksLocal(baseName) || componentNameLooksLocal(profile.name);
  const routeNamed =
    /(?:Page|Route|Screen|View)$/.test(baseName) ||
    /(?:Page|Route|Screen|View)$/.test(profile.name) ||
    lowerNameTokens.some((token) => ROUTE_NAME_TOKENS.has(token));
  if (routeNamed || (routeRootIndex >= 0 && !nestedLocalComponent && !componentNamed)) {
    return 'route-page';
  }
  return 'component';
}

function componentNameLooksLocal(name: string): boolean {
  const tokens = name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
  if (tokens.at(-1) && LOCAL_COMPONENT_NAME_SUFFIX_TOKENS.has(tokens.at(-1)!)) return true;
  return [...LOCAL_COMPONENT_NAME_SUFFIX_TOKENS].some((token) => name.endsWith(titleCaseToken(token)));
}

function recommendationKindFor(
  dominant: ReactLargeComponentPressureAxis,
  pressureKinds: ReactLargeComponentPressureAxis[],
  contextKind: ReactLargeComponentContextKind,
): ReactLargeComponentRecommendationKind {
  if (dominant === 'hook-behavior') return 'behavior-extraction';
  if (contextKind === 'route-page') return 'route-page-decomposition';
  if (pressureKinds.includes('hook-behavior')) return 'behavior-extraction';
  if (pressureKinds.includes('jsx-structure')) return 'jsx-decomposition';
  if (pressureKinds.includes('file')) return 'file-decomposition';
  if (dominant === 'jsx-structure') return 'jsx-decomposition';
  if (dominant === 'file' && !pressureKinds.includes('component')) return 'file-decomposition';
  return 'component-decomposition';
}

function recommendationFor(
  recommendationKind: ReactLargeComponentRecommendationKind,
  contextKind: ReactLargeComponentContextKind,
): string {
  switch (recommendationKind) {
    case 'behavior-extraction':
      return 'Extract independent state, effects, requests, or handlers into hooks, controllers, or feature modules.';
    case 'route-page-decomposition':
      return 'Split route/page orchestration from reusable panels and feature controllers.';
    case 'jsx-decomposition':
      return contextKind === 'route-page'
        ? 'Split page JSX into named layout sections before extracting behavior.'
        : 'Split repeated JSX sections into named presentational components.';
    case 'file-decomposition':
      return 'Review file-level decomposition; split colocated panels or helpers before changing behavior.';
    case 'component-decomposition':
      return 'Review component boundaries around props, state ownership, and independently changing UI sections.';
  }
}

const LOCAL_COMPONENT_DIRECTORY_TOKENS = new Set(['component', 'components', 'panel', 'panels', 'partial', 'partials']);
const LOCAL_COMPONENT_NAME_SUFFIX_TOKENS = new Set([
  'banner',
  'button',
  'card',
  'dialog',
  'drawer',
  'filter',
  'form',
  'grid',
  'header',
  'item',
  'list',
  'menu',
  'modal',
  'nav',
  'panel',
  'picker',
  'rail',
  'row',
  'section',
  'selector',
  'shell',
  'sidebar',
  'table',
  'toolbar',
]);
const ROUTE_DIRECTORY_TOKENS = new Set(['landing', 'page', 'pages', 'route', 'routes', 'screen', 'screens', 'view', 'views']);
const ROUTE_NAME_TOKENS = new Set(['landing', 'page', 'route', 'screen', 'view']);

function titleCaseToken(token: string): string {
  return token.charAt(0).toUpperCase() + token.slice(1);
}
