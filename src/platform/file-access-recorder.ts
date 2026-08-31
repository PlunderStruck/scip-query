/**
 * Records which repository files a bounded computation actually consulted.
 *
 * Per-file derivations that follow imports, resolved call targets, or another
 * file's definitions are pure functions of the consulted files' bytes — but
 * only a recorder at the shared read chokepoints can name that dependency set
 * without threading context through every resolver. A caching layer keys such
 * a derivation by its own file's content hash plus the recorded dependencies'
 * hashes, so a change in any consulted file invalidates the cached value.
 *
 * The recorder is a single synchronous ambient slot: arm it around a bounded
 * computation that neither awaits nor re-enters another armed computation.
 */
let activeRecorder: ((relativePath: string) => void) | null = null;

/** Reports one file access to the armed recorder, if any. */
export function recordFileAccess(relativePath: string): void {
  activeRecorder?.(relativePath);
}

/**
 * Runs a synchronous computation with file accesses reported to `onAccess`.
 * Nested recordings restore the outer recorder on exit; the recorder is
 * cleared even when the computation throws.
 */
export function withFileAccessRecording<T>(onAccess: (relativePath: string) => void, run: () => T): T {
  const previous = activeRecorder;
  activeRecorder = onAccess;
  try {
    return run();
  } finally {
    activeRecorder = previous;
  }
}
