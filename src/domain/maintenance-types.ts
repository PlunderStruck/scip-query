// ── Watch State ────────────────────────────────────────────

import type { SupportedLanguage } from './config-types.js';

export type WatcherStatus =
  | { state: 'idle' }
  | { state: 'waiting'; changedFiles: number; reindexAt: number }
  | { state: 'indexing'; startedAt: number }
  | { state: 'cooldown'; until: number; dirty: boolean };

export type RefreshTriggerKind =
  | 'manual-cli'
  | 'setup'
  | 'watch-source'
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
