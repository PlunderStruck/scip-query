import type { stats } from '../navigation/stats.js';

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
  duplicateBodies: CountLocSummary;
  reactComponentDuplicates: CountLocSummary;
  reactHookCandidates: CountLocSummary;
  reactLargeComponentPressure: CountLocSummary;
  vueComponentDuplicates: CountLocSummary;
  vueComposableCandidates: CountLocSummary;
  vueLargeViewPressure: CountLocSummary;
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
  /** Raw finding count reported to users. */
  count: number;
  /** Score-pressure count; lower than count when findings are broad discovery leads. */
  scoreCount?: number;
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
  direct: number;
  signal: number;
}

export interface ComplexitySummary {
  top: Array<{ symbol: string; score: number; file?: string }>;
  extremeCount: number;
}

export interface GitEvidenceSummary {
  amplification: ChangeAmplificationSummary | null;
  hiddenCoupling: {
    pairCount: number;
    scoreCount: number;
    top: Array<{
      fileA: string;
      fileB: string;
      together: number;
      confidence: number;
      focusedTogether: number;
      broadTogether: number;
      broadCommitRatio: number;
      lastTogetherAt: number;
      recentTogether: number;
      commitScope: 'focused' | 'mixed' | 'broad-sweep';
      recency: 'recent' | 'stale';
      scoreWeight: number;
      subjectContext: {
        subjectLabels: string[];
        issueRefs: string[];
        sampleSubjects: string[];
        externalIssueLabelStatus: 'unavailable';
      };
    }>;
  };
  /** Per-file change counts over the analyzed window (tracked files only). */
  fileStats: Record<string, { changes: number; fixChanges: number }>;
  commitsScanned: number;
}

export interface SuppressionSummary {
  total: number;
  byCategory: Record<string, number>;
}
