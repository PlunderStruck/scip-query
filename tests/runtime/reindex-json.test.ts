import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReindexResult } from '../../src/reindex/index.js';

// Plan 6 6.5.2: `reindex --json` gains a `shards` array while human output
// stays byte-for-byte compatible with the pre-existing status line. These
// tests mock the `reindex()` core function (already covered in depth by
// tests/reindex/reindex-reliability.test.ts) to isolate CLI option wiring.

const tempDirs: string[] = [];

function createProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scip-query-reindex-json-'));
  tempDirs.push(dir);
  return dir;
}

function withProjectRoot<T>(projectRoot: string, fn: () => T): T {
  const previous = process.env['SCIP_QUERY_PROJECT_ROOT'];
  process.env['SCIP_QUERY_PROJECT_ROOT'] = projectRoot;
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env['SCIP_QUERY_PROJECT_ROOT'];
    } else {
      process.env['SCIP_QUERY_PROJECT_ROOT'] = previous;
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('handleReindex --json', () => {
  it('emits a JSON envelope containing shard diagnostics', async () => {
    const projectRoot = createProject();
    const fakeResult: ReindexResult = {
      languages: ['typescript'],
      indexPath: join(projectRoot, 'index.scip'),
      dbPath: join(projectRoot, 'index.db'),
      durationMs: 42,
      reused: false,
      skipped: [],
      shards: [
        {
          id: 'typescript',
          language: 'typescript',
          reused: false,
          missReason: 'language inputs changed since last index',
          fingerprint: 'abc123',
          outputBytes: 10,
          durationMs: 42,
          command: 'typescript-indexer index --output index.scip',
        },
      ],
    };

    // The real reindex() always calls onStatus with human progress lines
    // (see src/reindex/index.ts). A fixture that never calls onStatus would
    // not catch a regression where --json output gets progress lines mixed
    // into stdout, so this mock calls it just like the real function would.
    vi.doMock('../../src/reindex/index.js', () => ({
      reindex: vi.fn(async (opts: { onStatus?: (message: string) => void }): Promise<ReindexResult> => {
        opts.onStatus?.('Detected languages: typescript');
        opts.onStatus?.('Done in 0.0s');
        return fakeResult;
      }),
      detectLanguages: () => ['typescript'],
      augmentAuxiliaryDocuments: vi.fn(),
      augmentVueResolvedReferences: vi.fn(),
    }));

    const { handleReindex } = await import('../../src/runtime/commands/command-handlers.js');
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    try {
      await withProjectRoot(projectRoot, () => handleReindex({ json: true }));
      // stdout must be pure JSON: exactly one direct write, matching every
      // other --json command in this CLI.
      expect(writes).toHaveLength(1);
      const payload = JSON.parse(writes[0]!) as {
        command: string;
        result: ReindexResult;
      };
      expect(payload.command).toBe('reindex');
      expect(payload.result.shards).toEqual(fakeResult.shards);
      expect(payload.result.reused).toBe(false);
    } finally {
      stdout.mockRestore();
    }
  });

  it('keeps the human status line unchanged when --json is not passed', async () => {
    const projectRoot = createProject();
    const fakeResult: ReindexResult = {
      languages: ['typescript'],
      indexPath: join(projectRoot, 'index.scip'),
      dbPath: join(projectRoot, 'index.db'),
      durationMs: 300,
      reused: true,
      skipped: [],
      shards: [
        {
          id: 'typescript',
          language: 'typescript',
          reused: true,
          fingerprint: 'abc123',
          outputBytes: 10,
          durationMs: 0,
        },
      ],
    };

    vi.doMock('../../src/reindex/index.js', () => ({
      reindex: vi.fn().mockResolvedValue(fakeResult),
      detectLanguages: () => ['typescript'],
      augmentAuxiliaryDocuments: vi.fn(),
      augmentVueResolvedReferences: vi.fn(),
    }));

    const { handleReindex } = await import('../../src/runtime/commands/command-handlers.js');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await withProjectRoot(projectRoot, () => handleReindex({}));
      expect(log.mock.calls.map((call) => call[0])).toEqual(['Reused typescript in 0.3s']);
    } finally {
      log.mockRestore();
    }
  });
});
