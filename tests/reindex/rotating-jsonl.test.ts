import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { tryAcquireProcessFileLock } from '../../src/platform/process-file-lock.js';
import {
  appendRotatingJsonlRecord,
  readRotatingJsonlLines,
  ROTATING_JSONL_LOCK_SUFFIX,
  RotatingJsonlLockReleaseError,
  RotatingJsonlLockTimeoutError,
  type RotatingJsonlPhase,
  type RotatingJsonlRuntime,
} from '../../src/reindex/rotating-jsonl.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('rotating JSONL', () => {
  it.each<RotatingJsonlPhase>(['tail-repaired', 'previous-pruned', 'current-rotated', 'record-appended'])(
    'serializes a competing writer at the %s phase without losing complete records',
    (contendedPhase) => {
      const path = historyPath();
      const old = { id: 'old', padding: 'x'.repeat(256) };
      const first = { id: 'first' };
      const second = { id: 'second' };
      const segmentLimit =
        Buffer.byteLength(`${JSON.stringify(first)}\n`) + Buffer.byteLength(`${JSON.stringify(second)}\n`);
      writeFileSync(path, `${JSON.stringify(old)}\n`);
      writeFileSync(`${path}.previous`, `${JSON.stringify({ id: 'expired-retention-segment' })}\n`);

      let competingError: unknown;
      appendRotatingJsonlRecord(path, first, {
        maxSegmentBytes: segmentLimit,
        onPhase(phase) {
          if (phase !== contendedPhase) return;
          try {
            appendRotatingJsonlRecord(path, second, {
              maxSegmentBytes: segmentLimit,
              lockTimeoutMs: 0,
            });
          } catch (error) {
            competingError = error;
          }
        },
      });
      expect(competingError).toBeInstanceOf(RotatingJsonlLockTimeoutError);

      appendRotatingJsonlRecord(path, second, { maxSegmentBytes: segmentLimit });

      expect(readIds(path)).toEqual(['old', 'first', 'second']);
      expect(existsSync(`${path}${ROTATING_JSONL_LOCK_SUFFIX}`)).toBe(false);
    },
  );

  it('repairs an incomplete crash tail before appending the next complete record', () => {
    const path = historyPath();
    const retained = `${JSON.stringify({ id: 'retained' })}\n`;
    const partial = '{"id":"crashed';
    writeFileSync(path, `${retained}${partial}`);

    const result = appendRotatingJsonlRecord(path, { id: 'recovered' }, { maxSegmentBytes: 1_024 });

    expect(result.repairedTailBytes).toBe(Buffer.byteLength(partial));
    expect(readIds(path)).toEqual(['retained', 'recovered']);
    expect(readFileSync(path, 'utf8')).toBe(`${retained}${JSON.stringify({ id: 'recovered' })}\n`);
  });

  it('recovers when a process crashes after rotation but before the new append', () => {
    const path = historyPath();
    const old = { id: 'old', padding: 'x'.repeat(128) };
    writeFileSync(path, `${JSON.stringify(old)}\n`);

    expect(() =>
      appendRotatingJsonlRecord(
        path,
        { id: 'crashed' },
        {
          maxSegmentBytes: 32,
          onPhase(phase) {
            if (phase === 'current-rotated') throw new Error('injected crash after rotation');
          },
        },
      ),
    ).toThrow('injected crash after rotation');
    expect(existsSync(path)).toBe(false);
    expect(JSON.parse(readFileSync(`${path}.previous`, 'utf8'))).toEqual(old);

    appendRotatingJsonlRecord(path, { id: 'recovered' }, { maxSegmentBytes: 32 });

    expect(readIds(path)).toEqual(['old', 'recovered']);
  });

  it('retains two bounded segments in previous-then-current order', () => {
    const path = historyPath();
    const records = [
      { id: 'one', padding: 'x'.repeat(32) },
      { id: 'two', padding: 'x'.repeat(32) },
      { id: 'three', padding: 'x'.repeat(32) },
    ];
    const lineBytes = Math.max(...records.map((record) => Buffer.byteLength(`${JSON.stringify(record)}\n`)));

    for (const record of records) {
      appendRotatingJsonlRecord(path, record, { maxSegmentBytes: lineBytes });
    }

    expect(readIds(path)).toEqual(['two', 'three']);
    expect(statSync(`${path}.previous`).size).toBeLessThanOrEqual(lineBytes);
    expect(statSync(path).size).toBeLessThanOrEqual(lineBytes);
  });

  it('ignores and counts partial legacy tails while reading complete lines deterministically', () => {
    const path = historyPath();
    const previous = `${JSON.stringify({ id: 'previous' })}\n`;
    const current = `${JSON.stringify({ id: 'current' })}\n`;
    writeFileSync(`${path}.previous`, `${previous}{"id":"partial-previous"`);
    writeFileSync(path, `${current}{"id":"partial-current"`);

    const result = readRotatingJsonlLines(path);

    expect(result.lines.map((line) => JSON.parse(line).id)).toEqual(['previous', 'current']);
    expect(result.ignoredPartialTailBytes).toBe(
      Buffer.byteLength('{"id":"partial-previous"') + Buffer.byteLength('{"id":"partial-current"'),
    );
  });

  it('rejects retained segments that exceed the explicit read budget', () => {
    const path = historyPath();
    writeFileSync(path, `${JSON.stringify({ id: 'oversized' })}\n`);

    expect(() => readRotatingJsonlLines(path, { maxSegmentBytes: 4 })).toThrow(
      /rotating JSONL segment.*safety limit is 4 bytes/u,
    );
  });

  it('reports bounded contention without modifying the retained segments', () => {
    const path = historyPath();
    writeFileSync(path, `${JSON.stringify({ id: 'retained' })}\n`);
    const acquired = tryAcquireProcessFileLock(`${path}${ROTATING_JSONL_LOCK_SUFFIX}`, {
      kind: 'rotating-jsonl-test',
    });
    if (acquired.kind !== 'acquired') throw new Error('test failed to acquire the rotating JSONL lock');
    try {
      expect(() =>
        appendRotatingJsonlRecord(
          path,
          { id: 'contended' },
          {
            maxSegmentBytes: 1_024,
            lockTimeoutMs: 0,
          },
        ),
      ).toThrow(RotatingJsonlLockTimeoutError);
      expect(readFileSync(path, 'utf8')).toBe(`${JSON.stringify({ id: 'retained' })}\n`);
    } finally {
      expect(acquired.lock.release()).toBe(true);
    }
  });

  it('rejects a non-serializable record before creating history or lock state', () => {
    const path = historyPath();

    expect(() => appendRotatingJsonlRecord(path, undefined, { maxSegmentBytes: 1_024 })).toThrow(
      'Rotating JSONL records must be JSON-serializable values.',
    );
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}${ROTATING_JSONL_LOCK_SUFFIX}`)).toBe(false);
  });

  it('reports an ownership-changed release after retaining the complete append', () => {
    const path = historyPath();

    expect(() =>
      appendRotatingJsonlRecord(
        path,
        { id: 'retained' },
        {
          maxSegmentBytes: 1_024,
          runtime: filesystemRuntime({ releaseResult: false }),
        },
      ),
    ).toThrow(RotatingJsonlLockReleaseError);
    expect(readFileSync(path, 'utf8')).toBe(`${JSON.stringify({ id: 'retained' })}\n`);
  });

  it('preserves the primary write failure when lock release also fails', () => {
    const path = historyPath();
    const runtime = filesystemRuntime({
      releaseResult: false,
      append() {
        throw new Error('injected append failure');
      },
    });

    expect(() =>
      appendRotatingJsonlRecord(
        path,
        { id: 'failed' },
        {
          maxSegmentBytes: 1_024,
          runtime,
        },
      ),
    ).toThrow('injected append failure');
  });
});

function historyPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'scip-query-rotating-jsonl-'));
  tempDirs.push(directory);
  return join(directory, 'history.jsonl');
}

function readIds(path: string): string[] {
  return readRotatingJsonlLines(path).lines.map((line) => (JSON.parse(line) as { id: string }).id);
}

function filesystemRuntime(options: {
  releaseResult: boolean;
  append?: (path: string, bytes: Buffer) => void;
}): RotatingJsonlRuntime {
  return {
    monotonicNow: () => 0,
    wait: () => undefined,
    tryAcquireLock: () => ({
      kind: 'acquired',
      lock: { release: () => options.releaseResult },
    }),
    makeDirectory: (path) => mkdirSync(path, { recursive: true }),
    exists: existsSync,
    readBytes: (path) => readFileSync(path),
    size: (path) => statSync(path).size,
    truncate: truncateSync,
    remove: (path) => rmSync(path, { force: true }),
    rename: renameSync,
    append: options.append ?? appendFileSync,
  };
}
