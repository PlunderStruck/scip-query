import {
  buildReactComponentBehaviorProfiles,
  type ReactComponentBehaviorProfile,
} from '../source/react-profile.js';
import type { ScipDatabase } from '../storage/db.js';

export type ReactLargeComponentPressureAxis =
  | 'component'
  | 'file'
  | 'jsx-structure'
  | 'hook-behavior';

export interface ReactLargeComponentPressureResult {
  file: string;
  component: string;
  componentLines: number;
  fileLines: number;
  jsxTokens: number;
  behaviorTokens: number;
  dominantPressure: ReactLargeComponentPressureAxis;
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
    .map((profile) => pressureResult(profile, {
      minComponentLines,
      minFileLines,
      minJsxTokens,
      minBehaviorTokens,
    }))
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

  return {
    file: profile.file,
    component: profile.name,
    componentLines: profile.loc,
    fileLines: profile.fileLines,
    jsxTokens: profile.jsxTokens.size,
    behaviorTokens: profile.behaviorTokens.size,
    dominantPressure: dominantPressure(profile),
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
