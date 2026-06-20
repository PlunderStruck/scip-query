import { buildVueComponentBehaviorProfiles, type VueComponentBehaviorProfile } from '../../source/vue/vue-profile.js';
import type { ScipDatabase } from '../../storage/db.js';

export type VueLargeViewPressureAxis = 'template' | 'script' | 'style' | 'external-script' | 'custom-block' | 'total';

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
    dominantPressure: dominantPressure(profile),
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
