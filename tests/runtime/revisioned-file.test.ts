import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tryAcquireProcessFileLock } from '../../src/platform/process-file-lock.js';
import { FileRevisionConflictError, mutateTextFileRevisionAware } from '../../src/runtime/revisioned-file.js';

const fixtureDirectories = new Set<string>();

afterEach(() => {
  for (const directory of fixtureDirectories) rmSync(directory, { recursive: true, force: true });
  fixtureDirectories.clear();
});

describe('revision-aware file mutation', () => {
  it('reapplies a narrow merge to an independent edit instead of overwriting it', () => {
    const { root, target } = fixture('{"user":1}\n');

    const result = mutateTextFileRevisionAware(
      target,
      (snapshot) => {
        const current = JSON.parse(snapshot.text) as Record<string, number>;
        return { kind: 'write', text: `${JSON.stringify({ ...current, owned: 2 })}\n` };
      },
      {
        onBeforeCommit: ({ attempt }) => {
          if (attempt === 0) writeFileSync(target, '{"user":3}\n');
        },
      },
    );

    expect(result.attempts).toBe(2);
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ user: 3, owned: 2 });
    expect(readdirSync(root)).toEqual(['state.json']);
  });

  it('surfaces a strict conflict with both revisions and preserves the winner', () => {
    const { target } = fixture('original\n');

    expect(() =>
      mutateTextFileRevisionAware(target, () => ({ kind: 'write', text: 'ours\n' }), {
        maxRetries: 0,
        onBeforeCommit: () => writeFileSync(target, 'theirs\n'),
      }),
    ).toThrow(FileRevisionConflictError);

    expect(readFileSync(target, 'utf8')).toBe('theirs\n');
  });

  it('bounds retries while a file keeps changing and leaves the latest bytes untouched', () => {
    const { target } = fixture('version-0\n');

    expect(() =>
      mutateTextFileRevisionAware(target, () => ({ kind: 'write', text: 'ours\n' }), {
        maxRetries: 2,
        onBeforeCommit: ({ attempt }) => writeFileSync(target, `version-${attempt + 1}\n`),
      }),
    ).toThrow(/Concurrent edit detected/);

    expect(readFileSync(target, 'utf8')).toBe('version-3\n');
  });

  it('turns a simultaneous first creation into a reread instead of replacing it', () => {
    const root = fixtureDirectory();
    const target = join(root, 'state.json');

    const result = mutateTextFileRevisionAware(
      target,
      (snapshot) => (snapshot.revision.exists ? { kind: 'unchanged' } : { kind: 'write', text: 'ours\n' }),
      {
        onBeforeCommit: ({ attempt }) => {
          if (attempt === 0) writeFileSync(target, 'theirs\n');
        },
      },
    );

    expect(result.changed).toBe(false);
    expect(result.attempts).toBe(2);
    expect(readFileSync(target, 'utf8')).toBe('theirs\n');
  });

  it('releases its lock and preserves the original when work crashes before commit', () => {
    const { root, target } = fixture('original\n');

    expect(() =>
      mutateTextFileRevisionAware(target, () => ({ kind: 'write', text: 'ours\n' }), {
        onBeforeCommit: () => {
          throw new Error('injected crash');
        },
      }),
    ).toThrow('injected crash');

    expect(readFileSync(target, 'utf8')).toBe('original\n');
    expect(readdirSync(root)).toEqual(['state.json']);
    expect(mutateTextFileRevisionAware(target, () => ({ kind: 'write', text: 'recovered\n' })).changed).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('recovered\n');
  });

  it('bounds lock contention with monotonic time', () => {
    const { target } = fixture('original\n');
    const lockPath = `${target}.scip-query-write.lock`;
    const acquired = tryAcquireProcessFileLock(lockPath, {
      kind: 'revisioned-file-mutation',
      detail: { target },
    });
    expect(acquired.kind).toBe('acquired');
    if (acquired.kind !== 'acquired') throw new Error('test lock acquisition failed');
    let monotonicNow = 0;

    try {
      expect(() =>
        mutateTextFileRevisionAware(target, () => ({ kind: 'write', text: 'ours\n' }), {
          lockTimeoutMs: 15,
          monotonicNow: () => {
            const observed = monotonicNow;
            monotonicNow += 10;
            return observed;
          },
        }),
      ).toThrow(/Timed out after 15ms/);
      expect(readFileSync(target, 'utf8')).toBe('original\n');
    } finally {
      acquired.lock.release();
    }
  });

  it('preserves an existing file mode across atomic replacement', () => {
    const { target } = fixture('original\n');
    chmodSync(target, 0o640);

    mutateTextFileRevisionAware(target, () => ({ kind: 'write', text: 'updated\n' }));

    expect(statSync(target).mode & 0o777).toBe(0o640);
  });
});

function fixture(contents: string): { root: string; target: string } {
  const root = fixtureDirectory();
  const target = join(root, 'state.json');
  writeFileSync(target, contents);
  return { root, target };
}

function fixtureDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'revisioned-file-test-'));
  fixtureDirectories.add(root);
  return root;
}
