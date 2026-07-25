import { describe, expect, it } from 'vitest';
import { decodeResultCursor, encodeResultCursor } from '../../src/runtime/result-pagination.js';

describe('result pagination cursors', () => {
  it('round-trips a cursor bound to command, target, and index generation', () => {
    const cursor = encodeResultCursor({
      command: 'refs',
      target: 'login',
      offset: 50,
      indexGeneration: 'generation-a',
    });

    expect(decodeResultCursor(cursor, { command: 'refs', target: 'login', indexGeneration: 'generation-a' })).toEqual({
      version: 1,
      command: 'refs',
      target: 'login',
      offset: 50,
      indexGeneration: 'generation-a',
    });
  });

  it('rejects a cursor after reindex or for a different target', () => {
    const cursor = encodeResultCursor({
      command: 'refs',
      target: 'login',
      offset: 50,
      indexGeneration: 'generation-a',
    });

    expect(() =>
      decodeResultCursor(cursor, { command: 'refs', target: 'login', indexGeneration: 'generation-b' }),
    ).toThrow(/index changed/);
    expect(() =>
      decodeResultCursor(cursor, { command: 'refs', target: 'logout', indexGeneration: 'generation-a' }),
    ).toThrow(/different command or target/);
  });
});
