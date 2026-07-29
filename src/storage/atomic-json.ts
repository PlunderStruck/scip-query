import { replaceFileAtomic, type AtomicFileRuntime, type AtomicFileWriteResult } from './atomic-file.js';

// scip-query: ignore-stale -- Serialization policy and atomic-write fault seam are shared across write paths.
export interface AtomicJsonWriteOptions {
  spacing?: number;
  trailingNewline?: boolean;
  /** @internal deterministic fault-injection boundary. */
  runtime?: AtomicFileRuntime;
}

/**
 * Visibility-atomic JSON replacement. Concurrent readers observe the old
 * complete document or the new complete document, never a partial write.
 * This function does not claim crash durability.
 */
export function writeJsonAtomic(path: string, value: unknown, options: AtomicJsonWriteOptions = {}): void {
  replaceFileAtomic(path, serializeJson(value, options), {
    durability: 'visibility',
    runtime: options.runtime,
  });
}

/**
 * Crash-durable JSON replacement. The file is flushed before rename and the
 * parent directory is flushed before success where the platform supports it.
 * Windows callers receive `directorySync: "unsupported"` when Node cannot
 * flush directory handles; file contents are still flushed and replacement is
 * visibility-atomic.
 */
export function writeJsonDurable(
  path: string,
  value: unknown,
  options: AtomicJsonWriteOptions = {},
): AtomicFileWriteResult {
  return replaceFileAtomic(path, serializeJson(value, options), {
    durability: 'durable',
    runtime: options.runtime,
  });
}

function serializeJson(value: unknown, options: AtomicJsonWriteOptions): string {
  const json = JSON.stringify(value, null, options.spacing);
  return options.trailingNewline ? `${json}\n` : json;
}
