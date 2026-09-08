import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as FileSystem from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readFileWithinLimit, hashFileWithinLimit } from '../../src/filesystem/bounded-file.js';
import { readProjectFile } from '../../src/platform/project-files.js';

const observation = vi.hoisted(() => ({ afterStat: undefined as (() => void) | undefined, bytesRead: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof FileSystem>();
  return {
    ...fs,
    fstatSync: (...args: Parameters<typeof fs.fstatSync>) => {
      const stat = fs.fstatSync(...args);
      const change = observation.afterStat;
      observation.afterStat = undefined;
      change?.();
      return stat;
    },
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      const result = fs.readFileSync(...args);
      observation.bytesRead += Buffer.byteLength(result);
      return result;
    },
    readSync: (...args: Parameters<typeof fs.readSync>) => {
      const count = fs.readSync(...args);
      observation.bytesRead += count;
      return count;
    },
  };
});

const directories: string[] = [];
afterEach(() => {
  observation.afterStat = undefined;
  observation.bytesRead = 0;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function artifact(): string {
  const directory = mkdtempSync(join(tmpdir(), 'scip-query-bounded-race-'));
  directories.push(directory);
  const path = join(directory, 'artifact');
  writeFileSync(path, '1234');
  return path;
}

describe('bounded regular file mutation', () => {
  it.each([
    { name: 'artifact', read: (path: string) => readFileWithinLimit(path, { inputKind: 'fixture', maxBytes: 4 }) },
    { name: 'project', read: (path: string) => readProjectFile(dirname(path), 'artifact', { maxBytes: 4 }) },
  ])('does not materialize growth beyond the admitted size through the $name reader', ({ read }) => {
    const path = artifact();
    observation.afterStat = () => writeFileSync(path, Buffer.alloc(1024 * 1024, 65));
    expect(() => read(path)).toThrow();
    expect(observation.bytesRead).toBeLessThanOrEqual(4);
  });

  it('rejects an observed same-size rewrite while reading a project file', () => {
    const path = artifact();
    observation.afterStat = () => {
      writeFileSync(path, '5678');
      utimesSync(path, new Date('2030-01-01'), new Date('2030-01-01'));
    };
    expect(() => readProjectFile(dirname(path), 'artifact', { maxBytes: 4 })).toThrow();
  });

  it('rejects truncation rather than returning an unfilled buffer', () => {
    const path = artifact();
    observation.afterStat = () => writeFileSync(path, '1');
    expect(() => readFileWithinLimit(path, { inputKind: 'fixture', maxBytes: 4 })).toThrow(/changed while/u);
  });

  it('rejects an observed same-size rewrite while hashing', () => {
    const path = artifact();
    expect(() =>
      hashFileWithinLimit(path, { inputKind: 'fixture', maxBytes: 4 }, () => {
        writeFileSync(path, '5678');
        utimesSync(path, new Date('2030-01-01'), new Date('2030-01-01'));
      }),
    ).toThrow(/changed while/u);
  });
});
