import { describe, expect, it } from 'vitest';

import { abortSignalReason, throwIfSignalAborted } from '../../src/platform/abort-signal.js';

describe('abort signal boundaries', () => {
  it('preserves an Error reason supplied by the cancellation owner', () => {
    const controller = new AbortController();
    const reason = new Error('owner exited');
    controller.abort(reason);

    expect(abortSignalReason(controller.signal, 'fallback')).toBe(reason);
    expect(() => throwIfSignalAborted(controller.signal, 'fallback')).toThrow(reason);
  });

  it('uses the boundary fallback when the reason is not an Error', () => {
    const controller = new AbortController();
    controller.abort('owner exited');

    expect(abortSignalReason(controller.signal, 'reindex cancelled')).toEqual(new Error('reindex cancelled'));
  });

  it('does nothing while the operation remains live', () => {
    expect(() => throwIfSignalAborted(new AbortController().signal, 'fallback')).not.toThrow();
    expect(() => throwIfSignalAborted(undefined, 'fallback')).not.toThrow();
  });
});
