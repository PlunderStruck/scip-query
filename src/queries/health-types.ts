import type { stats } from './stats.js';

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
}

export interface CountLocSummary {
  count: number;
  loc: number;
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
  top: Array<{ symbol: string; score: number }>;
  extremeCount: number;
}

export interface HealthBudget {
  candidateScanLimit: number | undefined;
  releaseCachesBetweenPhases: boolean;
  warnings: string[];
}
