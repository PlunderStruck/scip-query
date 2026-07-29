import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createFileAtomicExclusive,
  NODE_ATOMIC_FILE_RUNTIME,
  replaceFileAtomic,
  type AtomicFileRuntime,
} from '../../src/storage/atomic-file.js';
import { writeJsonAtomic, writeJsonDurable } from '../../src/storage/atomic-json.js';

const fixtureDirectories = new Set<string>();

afterEach(() => {
  for (const directory of fixtureDirectories) rmSync(directory, { recursive: true, force: true });
  fixtureDirectories.clear();
});

describe('atomic file replacement', () => {
  it('gives readers old-or-new complete bytes without claiming a flush', () => {
    const root = fixtureDirectory();
    const target = join(root, 'state.json');
    writeFileSync(target, 'old');
    const observations: string[] = [];
    const runtime = runtimeWith({
      randomToken: () => 'visibility',
      syncFile: () => {
        throw new Error('visibility mode must not flush');
      },
      renameFile: (source, destination) => {
        observations.push(readFileSync(destination, 'utf8'));
        renameSync(source, destination);
        observations.push(readFileSync(destination, 'utf8'));
      },
    });

    const result = replaceFileAtomic(target, 'new', { runtime });

    expect(result).toEqual({
      requestedDurability: 'visibility',
      achievedDurability: 'visibility',
      directorySync: 'not-requested',
    });
    expect(observations).toEqual(['old', 'new']);
    expect(readdirSync(root)).toEqual(['state.json']);
  });

  it('flushes the complete file before rename and its directory after rename', () => {
    const root = fixtureDirectory();
    const target = join(root, 'state.json');
    const actions: string[] = [];
    const runtime = tracingRuntime(actions, 'durable');

    const result = replaceFileAtomic(target, 'new', { durability: 'durable', runtime });

    expect(result).toEqual({
      requestedDurability: 'durable',
      achievedDurability: 'directory-durable',
      directorySync: 'synced',
    });
    expect(actions).toEqual([
      'open:state.json.tmp-durable:wx',
      'write:3',
      'sync:file',
      'close:file',
      'rename',
      'open:atomic-file-test-root:r',
      'sync:directory',
      'close:directory',
    ]);
    expect(readFileSync(target, 'utf8')).toBe('new');
  });

  it('does not steal a colliding staging file', () => {
    const root = fixtureDirectory();
    const target = join(root, 'state.json');
    const collision = `${target}.tmp-collision`;
    writeFileSync(target, 'old');
    writeFileSync(collision, 'other-owner');

    expect(() =>
      replaceFileAtomic(target, 'new', {
        runtime: runtimeWith({ randomToken: () => 'collision' }),
      }),
    ).toThrow(/EEXIST/);

    expect(readFileSync(target, 'utf8')).toBe('old');
    expect(readFileSync(collision, 'utf8')).toBe('other-owner');
  });

  it('removes its staging file after a partial write failure', () => {
    const { root, target } = existingTarget();
    let writes = 0;
    const runtime = runtimeWith({
      randomToken: () => 'write-failure',
      writeFile: (fd, bytes, offset, length) => {
        if (writes++ > 0) throw new Error('injected write failure');
        return NODE_ATOMIC_FILE_RUNTIME.writeFile(fd, bytes, offset, Math.min(1, length));
      },
    });

    expect(() => replaceFileAtomic(target, 'replacement', { runtime })).toThrow('injected write failure');

    expect(readFileSync(target, 'utf8')).toBe('old');
    expect(readdirSync(root)).toEqual(['state.json']);
  });

  it('removes its staging file when the file flush fails', () => {
    const { root, target } = existingTarget();
    const runtime = runtimeWith({
      randomToken: () => 'sync-failure',
      syncFile: () => {
        throw new Error('injected file sync failure');
      },
    });

    expect(() => replaceFileAtomic(target, 'new', { durability: 'durable', runtime })).toThrow(
      'injected file sync failure',
    );

    expect(readFileSync(target, 'utf8')).toBe('old');
    expect(readdirSync(root)).toEqual(['state.json']);
  });

  it('preserves the previous target and removes staging when rename fails after flush', () => {
    const { root, target } = existingTarget();
    let synced = false;
    const runtime = runtimeWith({
      randomToken: () => 'rename-failure',
      syncFile: (fd) => {
        synced = true;
        NODE_ATOMIC_FILE_RUNTIME.syncFile(fd);
      },
      renameFile: () => {
        throw new Error('injected rename failure');
      },
    });

    expect(() => replaceFileAtomic(target, 'new', { durability: 'durable', runtime })).toThrow(
      'injected rename failure',
    );

    expect(synced).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('old');
    expect(readdirSync(root)).toEqual(['state.json']);
  });

  it('reports a POSIX directory flush failure after the new complete file is visible', () => {
    const { root, target } = existingTarget();
    let syncCalls = 0;
    const runtime = runtimeWith({
      randomToken: () => 'directory-failure',
      syncFile: (fd) => {
        syncCalls += 1;
        if (syncCalls === 2) throw Object.assign(new Error('injected directory sync failure'), { code: 'EIO' });
        NODE_ATOMIC_FILE_RUNTIME.syncFile(fd);
      },
    });

    expect(() => replaceFileAtomic(target, 'new', { durability: 'durable', runtime })).toThrow(
      'injected directory sync failure',
    );

    expect(readFileSync(target, 'utf8')).toBe('new');
    expect(readdirSync(root)).toEqual(['state.json']);
  });

  it('classifies unsupported Windows directory flush without weakening file flush', () => {
    const root = fixtureDirectory();
    const target = join(root, 'state.json');
    let fileSynced = false;
    const runtime = runtimeWith({
      platform: 'win32',
      randomToken: () => 'windows',
      openFile: (path, flags, mode) => {
        if (path === root) throw Object.assign(new Error('directory handles unsupported'), { code: 'EPERM' });
        return NODE_ATOMIC_FILE_RUNTIME.openFile(path, flags, mode);
      },
      syncFile: (fd) => {
        fileSynced = true;
        NODE_ATOMIC_FILE_RUNTIME.syncFile(fd);
      },
    });

    const result = replaceFileAtomic(target, 'new', { durability: 'durable', runtime });

    expect(fileSynced).toBe(true);
    expect(result).toEqual({
      requestedDurability: 'durable',
      achievedDurability: 'file-flushed',
      directorySync: 'unsupported',
    });
    expect(readFileSync(target, 'utf8')).toBe('new');
  });
});

describe('exclusive atomic file creation', () => {
  it('publishes complete first-version bytes without replacing a competing target', () => {
    const root = fixtureDirectory();
    const target = join(root, 'state.json');

    const result = createFileAtomicExclusive(target, 'first', { durability: 'durable' });

    expect(result).toEqual({
      requestedDurability: 'durable',
      achievedDurability: 'directory-durable',
      directorySync: 'synced',
    });
    expect(readFileSync(target, 'utf8')).toBe('first');
    expect(readdirSync(root)).toEqual(['state.json']);
    expect(() => createFileAtomicExclusive(target, 'second', { durability: 'durable' })).toThrow(/EEXIST/);
    expect(readFileSync(target, 'utf8')).toBe('first');
    expect(readdirSync(root)).toEqual(['state.json']);
  });

  it('leaves no public or staged file when the staged write crashes', () => {
    const root = fixtureDirectory();
    const target = join(root, 'state.json');
    const runtime = runtimeWith({
      randomToken: () => 'exclusive-crash',
      writeFile: () => {
        throw new Error('injected exclusive write failure');
      },
    });

    expect(() => createFileAtomicExclusive(target, 'first', { durability: 'durable', runtime })).toThrow(
      'injected exclusive write failure',
    );
    expect(readdirSync(root)).toEqual([]);
  });
});

describe('atomic JSON durability contracts', () => {
  it('keeps the compatibility writer visibility-atomic and exposes durable status separately', () => {
    const root = fixtureDirectory();
    const visiblePath = join(root, 'visible.json');
    const durablePath = join(root, 'durable.json');

    expect(writeJsonAtomic(visiblePath, { value: 1 }, { spacing: 2, trailingNewline: true })).toBeUndefined();
    const durable = writeJsonDurable(durablePath, { value: 2 }, { spacing: 2, trailingNewline: true });

    expect(durable).toEqual({
      requestedDurability: 'durable',
      achievedDurability: 'directory-durable',
      directorySync: 'synced',
    });
    expect(readFileSync(visiblePath, 'utf8')).toBe('{\n  "value": 1\n}\n');
    expect(readFileSync(durablePath, 'utf8')).toBe('{\n  "value": 2\n}\n');
  });
});

function fixtureDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'atomic-file-test-root-'));
  fixtureDirectories.add(root);
  return root;
}

function existingTarget(): { root: string; target: string } {
  const root = fixtureDirectory();
  const target = join(root, 'state.json');
  writeFileSync(target, 'old');
  return { root, target };
}

function runtimeWith(overrides: Partial<AtomicFileRuntime>): AtomicFileRuntime {
  return { ...NODE_ATOMIC_FILE_RUNTIME, ...overrides };
}

function tracingRuntime(actions: string[], token: string): AtomicFileRuntime {
  const descriptors = new Map<number, 'file' | 'directory'>();
  return runtimeWith({
    randomToken: () => token,
    makeDirectory: (path) => {
      actions.push('mkdir');
      NODE_ATOMIC_FILE_RUNTIME.makeDirectory(path);
    },
    openFile: (path, flags, mode) => {
      const fd = NODE_ATOMIC_FILE_RUNTIME.openFile(path, flags, mode);
      const kind = path.endsWith(`.tmp-${token}`) ? 'file' : 'directory';
      descriptors.set(fd, kind);
      actions.push(
        `open:${path.endsWith(`.tmp-${token}`) ? `state.json.tmp-${token}` : 'atomic-file-test-root'}:${flags}`,
      );
      return fd;
    },
    writeFile: (fd, bytes, offset, length) => {
      actions.push(`write:${length}`);
      return NODE_ATOMIC_FILE_RUNTIME.writeFile(fd, bytes, offset, length);
    },
    syncFile: (fd) => {
      actions.push(`sync:${descriptors.get(fd)}`);
      NODE_ATOMIC_FILE_RUNTIME.syncFile(fd);
    },
    closeFile: (fd) => {
      actions.push(`close:${descriptors.get(fd)}`);
      descriptors.delete(fd);
      NODE_ATOMIC_FILE_RUNTIME.closeFile(fd);
    },
    renameFile: (source, target) => {
      actions.push('rename');
      NODE_ATOMIC_FILE_RUNTIME.renameFile(source, target);
    },
  });
}
