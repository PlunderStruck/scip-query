// ── Watch State ────────────────────────────────────────────

export type WatcherStatus =
  | { state: 'idle' }
  | { state: 'waiting'; changedFiles: number; reindexAt: number }
  | { state: 'indexing'; startedAt: number }
  | { state: 'cooldown'; until: number; dirty: boolean };
