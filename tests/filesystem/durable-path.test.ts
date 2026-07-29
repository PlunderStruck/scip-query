import { describe, expect, it } from 'vitest';
import { ensureDirectoryDurable, type DirectoryDurabilityRuntime } from '../../src/filesystem/durable-path.js';

describe('durable directory initialization', () => {
  it('persists every newly created component through its containing directory', () => {
    const actions: string[] = [];
    const runtime = directoryRuntime(actions, new Set(['/', '/repo']));

    expect(ensureDirectoryDurable('/repo/cache/nested', runtime)).toBe('synced');
    expect(actions).toEqual([
      'mkdir:/repo/cache',
      'open:/repo',
      'sync:/repo',
      'close:/repo',
      'mkdir:/repo/cache/nested',
      'open:/repo/cache',
      'sync:/repo/cache',
      'close:/repo/cache',
    ]);
  });

  it('does not issue ancestor work for an already established directory', () => {
    const actions: string[] = [];
    const runtime = directoryRuntime(actions, new Set(['/', '/repo', '/repo/cache']));

    expect(ensureDirectoryDurable('/repo/cache', runtime)).toBe('synced');
    expect(actions).toEqual([]);
  });

  it('reports an unsupported Windows directory handle without claiming full durability', () => {
    const actions: string[] = [];
    const runtime = directoryRuntime(actions, new Set(['/', '/repo']), 'win32');
    runtime.openFile = (path) => {
      actions.push(`open:${path}`);
      throw Object.assign(new Error('directory handles unsupported'), { code: 'EPERM' });
    };

    expect(ensureDirectoryDurable('/repo/cache', runtime)).toBe('unsupported');
    expect(actions).toEqual(['mkdir:/repo/cache', 'open:/repo']);
  });

  it('propagates a real directory synchronization failure', () => {
    const actions: string[] = [];
    const runtime = directoryRuntime(actions, new Set(['/', '/repo']));
    runtime.syncFile = (fd) => {
      actions.push(`sync:${fd}`);
      throw Object.assign(new Error('disk failed'), { code: 'EIO' });
    };

    expect(() => ensureDirectoryDurable('/repo/cache', runtime)).toThrow('disk failed');
  });
});

function directoryRuntime(
  actions: string[],
  existing: Set<string>,
  platform: NodeJS.Platform = 'darwin',
): DirectoryDurabilityRuntime {
  let descriptor = 0;
  const descriptors = new Map<number, string>();
  return {
    platform,
    pathExists: (path) => existing.has(path),
    makeDirectory(path) {
      actions.push(`mkdir:${path}`);
      existing.add(path);
    },
    openFile(path) {
      actions.push(`open:${path}`);
      const fd = ++descriptor;
      descriptors.set(fd, path);
      return fd;
    },
    syncFile(fd) {
      actions.push(`sync:${descriptors.get(fd)}`);
    },
    closeFile(fd) {
      actions.push(`close:${descriptors.get(fd)}`);
      descriptors.delete(fd);
    },
  };
}
