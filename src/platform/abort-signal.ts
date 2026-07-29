/** Preserve an Error abort reason or create a stable boundary-specific fallback. */
export function abortSignalReason(signal: AbortSignal, fallbackMessage: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(fallbackMessage);
}

/** Fail at an explicit cancellation boundary while preserving the owner's reason. */
export function throwIfSignalAborted(
  signal: AbortSignal | undefined,
  fallbackMessage: string,
): asserts signal is AbortSignal | undefined {
  if (signal?.aborted) throw abortSignalReason(signal, fallbackMessage);
}
