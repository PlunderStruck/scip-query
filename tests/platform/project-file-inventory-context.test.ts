import { describe, expect, it } from 'vitest';
import {
  cachedCanonicalProjectRoot,
  cachedGitProjectFileIndexVisibilityAfter,
  cachedGitProjectFileInventory,
  enterProjectFileListingCache,
  gitProjectFileInventoryPaths,
  gitProjectFileInventorySequence,
  withProjectFileListingCache,
} from '../../src/platform/project-file-inventory-context.js';

function cachedProjectFileListing(projectRoot: string, maxBytes: number, load: () => string): string {
  const inventory = cachedGitProjectFileInventory(projectRoot, maxBytes, () =>
    load()
      .split('\n')
      .filter(Boolean)
      .map((path) => `H ${path}\0`)
      .join(''),
  );
  return [...gitProjectFileInventoryPaths(inventory)].map((path) => `${path}\n`).join('');
}

describe('project file inventory context', () => {
  it('reuses one listing throughout a command scope', () => {
    let loads = 0;

    withProjectFileListingCache(() => {
      const first = cachedProjectFileListing('/repo', 1024, () => {
        loads += 1;
        return 'a.ts\n';
      });

      expect(cachedProjectFileListing('/repo', 1024, () => 'unexpected.ts\n')).toBe(first);
      expect(cachedProjectFileListing('/repo', 1024, () => 'still-unexpected.ts\n')).toBe(first);
    });

    expect(loads).toBe(1);
  });

  it('keeps repositories separate and does not leak inventories beyond the command', () => {
    withProjectFileListingCache(() => {
      expect(cachedProjectFileListing('/repo-a', 1024, () => 'a.ts\n')).toBe('a.ts\n');
      expect(cachedProjectFileListing('/repo-b', 1024, () => 'b.ts\n')).toBe('b.ts\n');
    });

    expect(cachedProjectFileListing('/repo-a', 1024, () => 'fresh.ts\n')).toBe('fresh.ts\n');
  });

  it('shares a successful empty Git listing', () => {
    let loads = 0;

    withProjectFileListingCache(() => {
      expect(
        cachedProjectFileListing('/empty-repo', 1024, () => {
          loads += 1;
          return '';
        }),
      ).toBe('');
      expect(cachedProjectFileListing('/empty-repo', 1024, () => 'unexpected.ts\n')).toBe('');
    });

    expect(loads).toBe(1);
  });

  it('does not reuse a listing beyond the next consumer hard bound', () => {
    let loads = 0;

    withProjectFileListingCache(() => {
      expect(
        cachedProjectFileListing('/large-repo', 1024, () => {
          loads += 1;
          return 'long-name.ts\n';
        }),
      ).toBe('long-name.ts\n');
      expect(() =>
        cachedProjectFileListing('/large-repo', 4, () => {
          loads += 1;
          return 'fallback.ts\n';
        }),
      ).toThrow('exceeded 4 path bytes');
    });

    expect(loads).toBe(2);
  });

  it('shares an existing cache through nested command scopes', () => {
    let loads = 0;

    withProjectFileListingCache(() => {
      expect(cachedProjectFileListing('/repo', 1024, () => `load-${++loads}`)).toBe('load-1\n');
      withProjectFileListingCache(() => {
        expect(cachedProjectFileListing('/repo', 1024, () => `load-${++loads}`)).toBe('load-1\n');
      });
    });

    expect(loads).toBe(1);
  });

  it('keeps one physical project-root identity for a command and releases it afterward', () => {
    let loads = 0;

    withProjectFileListingCache(() => {
      expect(cachedCanonicalProjectRoot('/repo', () => `/physical-${++loads}`)).toBe('/physical-1');
      expect(cachedCanonicalProjectRoot('/repo', () => `/physical-${++loads}`)).toBe('/physical-1');
      expect(cachedCanonicalProjectRoot('/repo-b', () => `/physical-${++loads}`)).toBe('/physical-2');
      withProjectFileListingCache(() => {
        expect(cachedCanonicalProjectRoot('/repo', () => `/physical-${++loads}`)).toBe('/physical-1');
      });
    });

    expect(cachedCanonicalProjectRoot('/repo', () => `/physical-${++loads}`)).toBe('/physical-3');
  });

  it('carries a pre-action inventory into asynchronous command work and releases it afterward', async () => {
    const release = enterProjectFileListingCache();
    try {
      expect(cachedProjectFileListing('/repo', 1024, () => 'pre-action.ts\n')).toBe('pre-action.ts\n');
      await Promise.resolve();
      expect(cachedProjectFileListing('/repo', 1024, () => 'unexpected.ts\n')).toBe('pre-action.ts\n');
    } finally {
      release();
    }

    expect(cachedProjectFileListing('/repo', 1024, () => 'next-command.ts\n')).toBe('next-command.ts\n');
  });

  it('preserves NUL-delimited paths and exposes visibility only after an earlier boundary', () => {
    withProjectFileListingCache(() => {
      const boundary = gitProjectFileInventorySequence();
      const inventory = cachedGitProjectFileInventory(
        '/repo',
        1024,
        () => 'H src/normal.ts\0H src/line\nbreak.ts\0? src/untracked.ts\0',
      );

      expect([...gitProjectFileInventoryPaths(inventory)]).toEqual([
        'src/normal.ts',
        'src/line\nbreak.ts',
        'src/untracked.ts',
      ]);
      expect(cachedGitProjectFileIndexVisibilityAfter('/repo', boundary)).toBe(true);
      expect(cachedGitProjectFileIndexVisibilityAfter('/repo', inventory.sequence)).toBeUndefined();
    });
  });

  it('rejects hidden tracked entries and malformed tagged output', () => {
    withProjectFileListingCache(() => {
      const boundary = gitProjectFileInventorySequence();
      cachedGitProjectFileInventory('/repo', 1024, () => 'h src/assumed.ts\0S src/skipped.ts\0');
      expect(cachedGitProjectFileIndexVisibilityAfter('/repo', boundary)).toBe(false);
      expect(() => cachedGitProjectFileInventory('/malformed', 1024, () => 'src/value.ts\0')).toThrow(
        'malformed tagged project file listing',
      );
    });
  });
});
