/**
 * Records repository files and indexed reference sets consulted by a bounded computation.
 *
 * Per-file derivations that follow imports, resolved call targets, or another
 * file's definitions depend on the consulted files' bytes. Shared-value proofs
 * also depend on which files reference the value: a new writer can change the
 * answer without changing any previously consulted file. The shared read owners name that dependency set
 * without threading context through every resolver. A caching layer keys such
 * a derivation by its own file's content hash plus the recorded dependencies'
 * hashes and reference membership, so either kind of change invalidates the cached value.
 *
 * Arm the recorder around a bounded synchronous computation. Nested recordings
 * also report their inputs to the enclosing computation; do not await inside one.
 */
let activeRecorder: ((relativePath: string) => void) | null = null;
let activeReferenceRecorder: ((symbol: string, files: readonly string[]) => void) | null = null;

/** Records a complete indexed reference-file set, including an empty set. */
export function recordSymbolReferenceAccess(symbol: string, files: readonly string[]): void {
  activeReferenceRecorder?.(symbol, files);
}

/** Reports one file access to the armed recorder, if any. */
export function recordFileAccess(relativePath: string): void {
  activeRecorder?.(relativePath);
}

/**
 * Runs a synchronous computation with file accesses reported to `onAccess`.
 * Nested recordings forward reads to the outer recorder and restore it on exit; the recorder is
 * cleared even when the computation throws.
 */
export function withFileAccessRecording<T>(
  onAccess: (relativePath: string) => void,
  run: () => T,
  onReferences?: (symbol: string, files: readonly string[]) => void,
): T {
  const previous = activeRecorder;
  const previousReferences = activeReferenceRecorder;
  activeRecorder = previous
    ? (file) => {
        previous(file);
        onAccess(file);
      }
    : onAccess;
  activeReferenceRecorder = onReferences
    ? (symbol, files) => {
        previousReferences?.(symbol, files);
        onReferences(symbol, files);
      }
    : previousReferences;
  try {
    return run();
  } finally {
    activeRecorder = previous;
    activeReferenceRecorder = previousReferences;
  }
}
