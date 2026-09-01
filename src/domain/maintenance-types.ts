// ── Watch State ────────────────────────────────────────────

import type { SupportedLanguage } from './config-types.js';

export type WatcherStatus =
  | { state: 'idle' }
  | { state: 'waiting'; changedFiles: number; reindexAt: number }
  | { state: 'indexing'; startedAt: number }
  | { state: 'cooldown'; until: number; dirty: boolean }
  | {
      state: 'budget-paused';
      until: number;
      dirty: boolean;
      reason: string;
      rebuilt: number;
      estimatedWriteBytes: number;
    }
  | { state: 'draining'; startedAt: number; reason: string };

export type RefreshTriggerKind =
  | 'manual-cli'
  | 'setup'
  | 'watch-source'
  | 'watch-startup'
  | 'watch-demand'
  | 'watch-git-head'
  | 'watch-git-index'
  | 'watch-git-state'
  | 'unknown';

export interface RefreshTrigger {
  kind: RefreshTriggerKind;
  detail?: string;
}

export type RefreshResultKind = 'rebuilt' | 'reused' | 'failed';

export interface LastRefreshMetadata {
  trigger: RefreshTrigger;
  result: RefreshResultKind;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  indexedLanguages?: SupportedLanguage[];
  skipped?: { language: SupportedLanguage; reason: string }[];
  error?: string;
}

export interface ReindexLanguageActivitySummary {
  runs: number;
  rebuilt: number;
  reused: number;
  /** Bytes emitted for this language's top-level cached SCIP shard. Reused shards contribute zero. */
  producedOutputBytes: number;
  /** Cumulative indexer time for rebuilt top-level shards; this is not end-to-end wall time. */
  durationMs: number;
}

export interface ReindexActivitySummary {
  /** Absent only on legacy watch-state records written before confidence reporting. */
  confidence?: 'complete' | 'partial' | 'unavailable';
  recordsRead?: number;
  invalidRecords?: number;
  skippedRecords?: number;
  readErrors?: number;
  ignoredPartialTailBytes?: number;
  windowStartedAt: string;
  windowEndedAt: string;
  runs: number;
  rebuilt: number;
  /**
   * Rebuilt runs whose language shards used a full indexer. Incremental SQLite
   * patches do not consume automatic rebuild slots. Absent on legacy watch-state
   * records; budget evaluation then falls back to `rebuilt`.
   */
  fullRebuilds?: number;
  reused: number;
  failed: number;
  suppressed: number;
  estimatedLogicalOutputBytes: number;
  /** Logical output plus staging bytes that required a real byte-copy fallback. */
  estimatedWriteBytes?: number;
  /** Bytes staged through copy-on-write cloning; reported separately because they do not rewrite the payload. */
  reflinkedBytes?: number;
  /** Bytes staged by a full byte copy because copy-on-write cloning was unavailable. */
  fallbackCopiedBytes?: number;
  /** Oldest completed rebuild retained inside this summary window. */
  oldestRebuildAt?: string;
  /** Oldest run with estimated physical writes retained inside this summary window. */
  oldestWriteAt?: string;
  /**
   * Completeness of optional top-level language-shard attribution. Aggregate
   * admission evidence remains authoritative when this field is partial.
   */
  languageAttribution?: 'complete' | 'partial' | 'unavailable';
  attributedRuns?: number;
  unattributedRuns?: number;
  invalidLanguageDetails?: number;
  byLanguage?: Partial<Record<SupportedLanguage, ReindexLanguageActivitySummary>>;
  byTrigger: Partial<Record<RefreshTriggerKind, number>>;
  /**
   * The subset of runs the watcher started itself (`watch-*` triggers). The
   * automatic resource budget is charged against this subset only: `setup`
   * and manual `reindex` work is explicit consent, not watcher churn. Absent
   * on legacy watch-state records; budget evaluation then falls back to the
   * window totals.
   */
  automatic?: ReindexAutomaticActivitySummary;
}

export interface ReindexAutomaticActivitySummary {
  runs: number;
  rebuilt: number;
  fullRebuilds: number;
  estimatedWriteBytes: number;
  oldestRebuildAt?: string;
  oldestWriteAt?: string;
}
