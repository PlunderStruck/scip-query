import { describe, expect, it } from 'vitest';
import {
  cachedProjectFileListing,
  enterProjectFileListingCache,
  withProjectFileListingCache,
} from '../../src/platform/project-file-inventory-context.js';

describe('project file inventory context', () => {
  it('hands off one command-scoped listing once', () => {
    let loads = 0;

    withProjectFileListingCache(() => {
      const first = cachedProjectFileListing('/repo', 1024, () => {
        loads += 1;
        return 'a.ts\n';
      });

      expect(cachedProjectFileListing('/repo', 1024, () => 'unexpected.ts\n')).toBe(first);
      expect(
        cachedProjectFileListing('/repo', 1024, () => {
          loads += 1;
          return 'reloaded.ts\n';
        }),
      ).toBe('reloaded.ts\n');
    });

    expect(loads).toBe(2);
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
      expect(
        cachedProjectFileListing('/large-repo', 4, () => {
          loads += 1;
          return 'fallback.ts\n';
        }),
      ).toBe('fallback.ts\n');
    });

    expect(loads).toBe(2);
  });

  it('shares an existing cache through nested command scopes', () => {
    let loads = 0;

    withProjectFileListingCache(() => {
      expect(cachedProjectFileListing('/repo', 1024, () => `load-${++loads}`)).toBe('load-1');
      withProjectFileListingCache(() => {
        expect(cachedProjectFileListing('/repo', 1024, () => `load-${++loads}`)).toBe('load-1');
      });
    });

    expect(loads).toBe(1);
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
});
