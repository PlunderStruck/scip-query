// ── Redundant Re-export Types ─────────────────────────────

export interface RedundantReexport {
  barrelFile: string;
  symbol: string;
  shortName: string;
  originalFile: string;
  /** How many consumers import through the barrel */
  barrelConsumers: number;
  /** How many consumers import directly from the source */
  directConsumers: number;
}

// ── Similar Signature Types ───────────────────────────────

export interface SimilarSignatureGroup {
  /** The normalized signature shared by all functions in the group */
  signature: string;
  /** Functions that share this signature */
  functions: Array<{
    symbol: string;
    shortName: string;
    file: string;
    startLine: number;
    endLine: number;
    loc: number;
  }>;
}

// ── Watch State ────────────────────────────────────────────

export type WatcherStatus =
  | { state: 'idle' }
  | { state: 'waiting'; changedFiles: number; reindexAt: number }
  | { state: 'indexing'; startedAt: number }
  | { state: 'cooldown'; until: number; dirty: boolean };
