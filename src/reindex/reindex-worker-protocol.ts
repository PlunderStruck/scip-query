/**
 * Exit status used when a watch reindex could not start because another
 * cache owner is publishing or rebuilding the same index. The watcher may
 * retry this outcome; every other non-zero status remains a terminal error.
 */
export const REINDEX_WORKER_RETRYABLE_EXIT_CODE = 75;

/** A temporary ownership conflict, not an indexer or publication failure. */
export class ReindexLockUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReindexLockUnavailableError';
  }
}
