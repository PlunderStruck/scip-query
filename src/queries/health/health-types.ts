import type { stats } from '../navigation/stats.js';
import type { DetectorEvidenceAssessment } from './detector-evidence-contracts.js';

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
  detectorEvidence: DetectorEvidenceAssessment[];
  dead: CountLocSummary;
  isolated: CountLocSummary;
  /** Real cycles on the import graph; symbol-reference-only components are disclosed in `cycleExclusions`. */
  realCycleCount: number;
  /** Components that cycle through type or symbol references but not through imports; not counted. */
  cycleExclusions: PolicyExclusionSummary[];
  similarCount: number;
  duplicateBodies: CountLocSummary;
  /** Same-name-family (or near-name) twins with divergent or identical bodies (Q1). */
  twinDrift: CountLocSummary;
  reactComponentDuplicates: CountLocSummary;
  reactHookCandidates: CountLocSummary;
  reactLargeComponentPressure: CountLocSummary;
  vueComponentDuplicates: CountLocSummary;
  vueComposableCandidates: CountLocSummary;
  vueLargeViewPressure: CountLocSummary;
  extractCount: number;
  /** Wide-interface regions listed by extract-candidates at support tier and not counted. */
  extractExclusions: PolicyExclusionSummary[];
  wrappers: CountLocSummary;
  passthroughs: CountLocSummary;
  stale: StaleSummary;
  drift: DriftSummary;
  complexity: ComplexitySummary;
  /** Git change-graph evidence; null when git history is unavailable. */
  gitEvidence: GitEvidenceSummary | null;
  /** User-suppression inventory; null when the phase didn't run. */
  suppressions: SuppressionSummary | null;
  /** Configured coverage-contract violations (enumeration rot); count 0 when none are configured. */
  coverageContracts: CountLocSummary;
}

export interface CountLocSummary {
  /** Raw finding count reported to users. */
  count: number;
  /** Score-pressure count; lower than count when findings are broad discovery leads. */
  scoreCount?: number;
  loc: number;
  /** Files contributing findings — feeds fix-density validation. */
  files?: string[];
  /**
   * Rows a detector policy removed from the count (test scaffolding, vendored
   * kit primitives, framework-mandated twins). Disclosed so an excluded row is
   * never mistaken for an absent one.
   */
  exclusions?: PolicyExclusionSummary[];
}

export interface PolicyExclusionSummary {
  /** Stable identifier for the excluding policy. */
  reason: string;
  /** Reviewer-facing explanation of what was excluded and why. */
  detail: string;
  count: number;
}

export interface StaleSummary extends CountLocSummary {
  unused: number;
  singleUse: number;
}

export interface DriftSummary {
  count: number;
  unusedImports: number;
  architectureViolations: number;
  /** @deprecated Use `architectureViolations`. */
  layerViolations: number;
  direct: number;
  signal: number;
}

export interface ComplexitySummary {
  top: Array<{ symbol: string; score: number; file?: string }>;
  extremeCount: number;
  /** Hotspots above the extreme score that policy did not count (disclosed). */
  exclusions?: PolicyExclusionSummary[];
}

export interface GitEvidenceSummary {
  amplification: ChangeAmplificationSummary | null;
  hiddenCoupling: {
    pairCount: number;
    scoreCount: number;
    /** Co-change pairs policy did not count as hidden coupling (disclosed). */
    exclusions?: PolicyExclusionSummary[];
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
