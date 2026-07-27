import { describe, expect, it } from 'vitest';
import {
  decodeCompatibleResultCursor,
  decodeResultCursor,
  encodeResultCursor,
} from '../../src/runtime/result-pagination.js';

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

  it('round-trips a versioned keyset cursor and still decodes legacy offsets', () => {
    const keyset = encodeResultCursor({
      command: 'refs',
      target: 'login',
      after: { relativePath: 'src/login.ts', line: 42 },
      producer: 'source-keyset',
      semanticEnrichment: false,
      indexGeneration: 'generation-a',
    });
    const legacy = encodeResultCursor({
      command: 'refs',
      target: 'login',
      offset: 50,
      indexGeneration: 'generation-a',
    });

    expect(
      decodeCompatibleResultCursor(keyset, {
        command: 'refs',
        target: 'login',
        indexGeneration: 'generation-a',
      }),
    ).toEqual({
      version: 2,
      command: 'refs',
      target: 'login',
      after: { relativePath: 'src/login.ts', line: 42 },
      producer: 'source-keyset',
      semanticEnrichment: false,
      indexGeneration: 'generation-a',
    });
    expect(
      decodeCompatibleResultCursor(legacy, {
        command: 'refs',
        target: 'login',
        indexGeneration: 'generation-a',
      }),
    ).toMatchObject({ version: 1, offset: 50 });
  });

  it('rejects keyset cursors after the index generation changes', () => {
    const cursor = encodeResultCursor({
      command: 'refs',
      target: 'login',
      after: { relativePath: 'src/login.ts', line: 42 },
      producer: 'source-keyset',
      semanticEnrichment: false,
      indexGeneration: 'generation-a',
    });

    expect(() =>
      decodeCompatibleResultCursor(cursor, {
        command: 'refs',
        target: 'login',
        indexGeneration: 'generation-b',
      }),
    ).toThrow(/index changed/);
  });
});
