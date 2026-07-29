import { describe, expect, it } from 'vitest';
import { cloneFileDurable, type DurableFileCloneRuntime } from '../../src/filesystem/durable-file.js';

describe('durable artifact cloning', () => {
  it('applies the final mode before flushing bytes and publishing the target name', () => {
    const actions: string[] = [];
    const runtime = cloneRuntime(actions);

    expect(cloneFileDurable('/source', '/target/artifact', { mode: 0o444, runtime })).toBe('synced');
    expect(actions).toEqual([
      'copy:/source:/target/artifact',
      'chmod:/target/artifact:444',
      'open:/target/artifact',
      'sync:/target/artifact',
      'close:/target/artifact',
      'open:/target',
      'sync:/target',
      'close:/target',
    ]);
  });

  it('does not publish a clone when final-mode hardening fails', () => {
    const actions: string[] = [];
    const runtime = cloneRuntime(actions);
    runtime.chmodFile = () => {
      throw new Error('chmod failed');
    };

    expect(() => cloneFileDurable('/source', '/target/artifact', { mode: 0o444, runtime })).toThrow('chmod failed');
    expect(actions).toEqual(['copy:/source:/target/artifact']);
  });

  it('closes the artifact and skips namespace publication when the final file flush fails', () => {
    const actions: string[] = [];
    const runtime = cloneRuntime(actions);
    runtime.syncFile = (fd) => {
      const path = descriptorPaths.get(fd);
      actions.push(`sync:${path}`);
      if (path === '/target/artifact') throw new Error('file sync failed');
    };

    expect(() => cloneFileDurable('/source', '/target/artifact', { mode: 0o444, runtime })).toThrow('file sync failed');
    expect(actions.at(-1)).toBe('close:/target/artifact');
    expect(actions).not.toContain('open:/target');
  });
});

const descriptorPaths = new Map<number, string>();

function cloneRuntime(actions: string[]): DurableFileCloneRuntime {
  descriptorPaths.clear();
  let descriptor = 0;
  return {
    platform: 'darwin',
    pathExists: (path) => path === '/' || path === '/target',
    makeDirectory(path) {
      actions.push(`mkdir:${path}`);
    },
    copyFile(source, target) {
      actions.push(`copy:${source}:${target}`);
    },
    chmodFile(path, mode) {
      actions.push(`chmod:${path}:${mode.toString(8)}`);
    },
    openFile(path) {
      actions.push(`open:${path}`);
      const fd = ++descriptor;
      descriptorPaths.set(fd, path);
      return fd;
    },
    syncFile(fd) {
      actions.push(`sync:${descriptorPaths.get(fd)}`);
    },
    closeFile(fd) {
      actions.push(`close:${descriptorPaths.get(fd)}`);
      descriptorPaths.delete(fd);
    },
  };
}
