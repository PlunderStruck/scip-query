import type { stats } from './stats.js';

/**
 * Structural copy of analysis/git-history's ChangeAmplification — defined
 * here so the report envelope consumed by runtime/ does not pull analysis/
 * types across the layer boundary.
 */
export interface ChangeAmplificationSummary {
  medianFilesPerCommit: number;
  p90FilesPerCommit: number;
  commitsAnalyzed: number;
}

export interface HealthAnalyses {
  statsResult: ReturnType<typeof stats>;
  warnings: string[];
  dead: CountLocSummary;
  isolated: CountLocSummary;
  realCycleCount: number;
  similarCount: number;
  extractCount: number;
  wrappers: CountLocSummary;
  passthroughs: CountLocSummary;
  stale: StaleSummary;
  drift: DriftSummary;
  complexity: ComplexitySummary;
  /** Git change-graph evidence; null when git history is unavailable. */
  gitEvidence: GitEvidenceSummary | null;
  /** User-suppression inventory; null when the phase didn't run. */
  suppressions: SuppressionSummary | null;
}

export interface CountLocSummary {
  count: number;
  loc: number;
  /** Files contributing findings — feeds fix-density validation. */
  files?: string[];
}

export interface StaleSummary extends CountLocSummary {
  unused: number;
  singleUse: number;
}

export interface DriftSummary {
  count: number;
  unusedImports: number;
  layerViolations: number;
}

export interface ComplexitySummary {
  top: Array<{ symbol: string; score: number; file?: string }>;
  extremeCount: number;
}

export interface GitEvidenceSummary {
  amplification: ChangeAmplificationSummary | null;
  hiddenCoupling: {
    pairCount: number;
    top: Array<{ fileA: string; fileB: string; together: number; confidence: number }>;
  };
  /** Per-file change counts over the analyzed window (tracked files only). */
  fileStats: Record<string, { changes: number; fixChanges: number }>;
}

export interface SuppressionSummary {
  total: number;
  byCategory: Record<string, number>;
}
