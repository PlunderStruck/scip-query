import { frontendBehaviorProduct } from '../../source/frontend-behavior-products.js';
import type { ReactComponentBehaviorProfile } from '../../source/react-profile.js';
import type { ScipDatabase } from '../../storage/db.js';
import { evaluatePressure, type PressureAxis } from '../internal/frontend-behavior-evidence.js';

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
  const profiles = frontendBehaviorProduct(db)
    .reactProfiles({ scope, scanLimit })
    .filter((profile) => profile.kind === 'component')
    .filter((profile) => !filePattern || profile.file.includes(filePattern) || profile.name.includes(filePattern));
  return profiles
    .map((profile) =>
      reactPressureResult(profile, {
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

function reactPressureResult(
  profile: ReactComponentBehaviorProfile,
  thresholds: {
    minComponentLines: number;
    minFileLines: number;
    minJsxTokens: number;
    minBehaviorTokens: number;
  },
): ReactLargeComponentPressureResult | null {
  const substantialComponentLines = Math.max(80, Math.floor(thresholds.minComponentLines / 2));
  const pressure = evaluatePressure(
    profile,
    reactPressureAxes({
      minComponentLines: thresholds.minComponentLines,
      minFileLines: thresholds.minFileLines,
      minJsxTokens: thresholds.minJsxTokens,
      minBehaviorTokens: thresholds.minBehaviorTokens,
      substantialComponentLines,
    }),
    'component',
  );
  const { reasons } = pressure;
  if (reasons.length === 0) return null;

  const dominant = pressure.dominantPressure;
  const pressureKinds = pressure.pressureKinds;
  const contextKind = reactContextKind(profile);
  const recommendationKind = reactRecommendationKindFor(dominant, pressureKinds, contextKind);
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
    recommendation: reactRecommendationFor(recommendationKind, contextKind),
    reasons,
    loc: profile.loc,
  };
}

function reactPressureAxes(thresholds: {
  minComponentLines: number;
  minFileLines: number;
  minJsxTokens: number;
  minBehaviorTokens: number;
  substantialComponentLines: number;
}): PressureAxis<ReactComponentBehaviorProfile, ReactLargeComponentPressureAxis>[] {
  return [
    {
      axis: 'component',
      value: (profile) => profile.loc,
      qualifies: (_profile, value) => value >= thresholds.minComponentLines,
      reason: (_profile, value) => `${value} component line(s)`,
    },
    {
      axis: 'file',
      value: (profile) => profile.fileLines,
      qualifies: (profile, value) =>
        value >= thresholds.minFileLines && profile.loc >= thresholds.substantialComponentLines,
      reason: (_profile, value) => `${value} file line(s)`,
    },
    {
      axis: 'jsx-structure',
      value: (profile) => profile.jsxTokens.size,
      weightedValue: (_profile, value) => value * 3,
      qualifies: (_profile, value) => value >= thresholds.minJsxTokens,
      reason: (_profile, value) => `${value} JSX structure token(s)`,
    },
    {
      axis: 'hook-behavior',
      value: (profile) => profile.behaviorTokens.size,
      weightedValue: (_profile, value) => value * 4,
      qualifies: (_profile, value) => value >= thresholds.minBehaviorTokens,
      reason: (_profile, value) => `${value} behavior token(s)`,
    },
  ];
}

function reactContextKind(profile: ReactComponentBehaviorProfile): ReactLargeComponentContextKind {
  const segments = profile.file.split(/[\\/]+/).filter(Boolean);
  const ownerSegments = segments.slice(0, -1).map((segment) => segment.toLowerCase());
  const baseName = (segments.at(-1) ?? profile.name).replace(/\.[^.]+$/, '');
  const routeRootIndex = ownerSegments.findIndex((segment) => ROUTE_DIRECTORY_TOKENS.has(segment));
  const routeOwned = routeRootIndex >= 0;
  const localComponentDirectory = ownerSegments.some((segment) => LOCAL_COMPONENT_DIRECTORY_TOKENS.has(segment));
  const componentNamed = componentNameLooksLocal(baseName) || componentNameLooksLocal(profile.name);
  if (componentNamed) return 'component';

  const conventionalRouteFile = REACT_ROUTE_FILE_NAMES.has(baseName.toLowerCase());
  const explicitlyRouteNamed = /(?:Page|Route|Screen)$/.test(profile.name);
  const routeOwnedView = routeOwned && /View$/.test(profile.name);
  const sameNamedRouteModule =
    !localComponentDirectory &&
    baseName.replace(/[^A-Za-z0-9]+/g, '').toLowerCase() === profile.name.replace(/[^A-Za-z0-9]+/g, '').toLowerCase() &&
    /(?:Page|Route|Screen|View)$/.test(baseName);
  if (conventionalRouteFile || explicitlyRouteNamed || routeOwnedView || sameNamedRouteModule) {
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

function reactRecommendationKindFor(
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

function reactRecommendationFor(
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
const ROUTE_DIRECTORY_TOKENS = new Set([
  'landing',
  'page',
  'pages',
  'route',
  'routes',
  'screen',
  'screens',
  'view',
  'views',
]);
const REACT_ROUTE_FILE_NAMES = new Set(['page', 'route', 'screen']);

function titleCaseToken(token: string): string {
  return token.charAt(0).toUpperCase() + token.slice(1);
}
