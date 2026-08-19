import type { LastRefreshMetadata, SupportedLanguage } from '../domain/types.js';
import type { ReindexWriteTelemetry } from '../platform/file-clone.js';

// One entry per cached indexing unit: a language shard, or one TypeScript
// workspace project shard within a language.
export interface ReindexShardDiagnostic {
  /** Unique id for this shard: the language, or `<language>:<projectPath>` for a TS workspace sub-project. */
  id: string;
  language: SupportedLanguage;
  /** True when the cached shard was reused without rerunning its indexer. */
  reused: boolean;
  /** How this shard was obtained during the refresh. */
  strategy: 'reused' | 'incremental' | 'full';
  /** Present only when `reused` is false: why the cached shard could not be used. */
  missReason?: string;
  /** Present when a preferred refresh strategy failed and the shard was rebuilt another way. */
  fallbackReason?: string;
  /** Short hash of this shard's fingerprint inputs (source content + indexer options). */
  fingerprint: string;
  /** Size in bytes of the shard's cached SCIP output, or null when unavailable. */
  outputBytes: number | null;
  /** Bytes newly emitted by this run; absent when outputBytes is already the produced size. */
  producedOutputBytes?: number;
  /** Wall time spent producing this shard; 0 when reused. */
  durationMs: number;
  /** Indexer command invoked to produce this shard; absent when reused. */
  command?: string;
}

export interface ReindexResult {
  /** Languages that were successfully indexed. */
  languages: SupportedLanguage[];
  indexPath: string;
  dbPath: string;
  durationMs: number;
  /** True when existing SCIP/SQLite outputs were reused because inputs were unchanged. */
  reused: boolean;
  /**
   * Languages detected in the project but skipped because their indexer
   * could not be located, installed, or run. Each entry includes the reason.
   */
  skipped: { language: SupportedLanguage; reason: string }[];
  /** Persisted description of this refresh attempt. */
  lastRefresh?: LastRefreshMetadata;
  /** Per-shard reuse diagnostics; one entry per language/workspace shard. */
  shards?: ReindexShardDiagnostic[];
  /** Staging-copy cost split by copy-on-write clones and real byte-copy fallbacks. */
  writeTelemetry?: ReindexWriteTelemetry;
}
