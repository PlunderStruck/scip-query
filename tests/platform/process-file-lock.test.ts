import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NODE_PROCESS_FILE_LOCK_RUNTIME,
  PROCESS_FILE_LOCK_PROTOCOL,
  PROCESS_FILE_LOCK_VERSION,
  readProcessFileLock,
  reclaimProcessFileLock,
  releaseOwnedProcessFileLock,
  tryAcquireProcessFileLock,
  decodeLegacyPidLock,
  type ProcessFileLockRecord,
  type ProcessFileLockRuntime,
} from '../../src/platform/process-file-lock.js';
import type { ProcessIdentity } from '../../src/platform/process-identity.js';

const tempDirs: string[] = [];
const OWNER_IDENTITY: ProcessIdentity = {
  version: 1,
  pid: 41_001,
  platform: 'linux',
  startToken: 'owner-start',
};
const SUCCESSOR_IDENTITY: ProcessIdentity = {
  ...OWNER_IDENTITY,
  startToken: 'successor-start',
};

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('process file lock protocol', () => {
  it.each([null, [], {}, { pid: '42' }, { pid: 0 }, { pid: -1 }, { pid: 1.5 }, { pid: Number.MAX_SAFE_INTEGER + 1 }])(
    'does not reclaim malformed legacy ownership %j',
    (value) => {
      const lockPath = temporaryLockPath();
      const raw = JSON.stringify(value);
      writeFileSync(lockPath, raw);
      const result = tryAcquireProcessFileLock(lockPath, {
        kind: 'test',
        parseLegacy: decodeLegacyPidLock,
        runtime: lockRuntime(),
      });
      expect(result.kind).toBe('contended');
      expect(readFileSync(lockPath, 'utf8')).toBe(raw);
    },
  );

  it('publishes a versioned, token-owned record and flushes the file before its directory', () => {
    const lockPath = temporaryLockPath();
    const events: string[] = [];
    const fileDescriptors = new Map<number, string>();
    const runtime = lockRuntime({
      randomToken: () => 'owner-token',
      readProcessIdentity: () => OWNER_IDENTITY,
      openFile(path, flags, mode) {
        const fd = NODE_PROCESS_FILE_LOCK_RUNTIME.openFile(path, flags, mode);
        fileDescriptors.set(fd, path);
        events.push(`open:${path === lockPath ? 'lock' : path.endsWith('.candidate') ? 'candidate' : 'directory'}`);
        return fd;
      },
      writeFile(fd, bytes, offset, length) {
        events.push('write');
        return NODE_PROCESS_FILE_LOCK_RUNTIME.writeFile(fd, bytes, offset, length);
      },
      syncFile(fd) {
        events.push(`sync:${fileDescriptors.get(fd)?.endsWith('.candidate') ? 'lock' : 'directory'}`);
        NODE_PROCESS_FILE_LOCK_RUNTIME.syncFile(fd);
      },
      closeFile(fd) {
        NODE_PROCESS_FILE_LOCK_RUNTIME.closeFile(fd);
        fileDescriptors.delete(fd);
      },
      linkFile(existingPath, newPath) {
        events.push('publish');
        NODE_PROCESS_FILE_LOCK_RUNTIME.linkFile(existingPath, newPath);
      },
      removeFile(path) {
        events.push(`remove:${path.endsWith('.candidate') ? 'candidate' : 'lock'}`);
        NODE_PROCESS_FILE_LOCK_RUNTIME.removeFile(path);
      },
    });

    const result = tryAcquireProcessFileLock(lockPath, {
      kind: 'test',
      pid: OWNER_IDENTITY.pid,
      runtime,
    });

    expect(result.kind).toBe('acquired');
    const record = JSON.parse(readFileSync(lockPath, 'utf8')) as ProcessFileLockRecord;
    expect(record).toEqual(
      expect.objectContaining({
        protocol: PROCESS_FILE_LOCK_PROTOCOL,
        version: PROCESS_FILE_LOCK_VERSION,
        kind: 'test',
        pid: OWNER_IDENTITY.pid,
        token: 'owner-token',
        processIdentity: OWNER_IDENTITY,
      }),
    );
    expect(events).toEqual([
      'open:candidate',
      'write',
      'sync:lock',
      'publish',
      'remove:candidate',
      'open:directory',
      'sync:directory',
    ]);
    if (result.kind === 'acquired') expect(result.lock.release()).toBe(true);
    expect(events.slice(-3)).toEqual(['remove:lock', 'open:directory', 'sync:directory']);
  });

  it('keeps the ownership record durable while allowing recoverable directory entries', () => {
    const lockPath = temporaryLockPath();
    const syncedPaths: string[] = [];
    const fileDescriptors = new Map<number, string>();
    const runtime = lockRuntime({
      randomToken: () => 'recoverable-token',
      readProcessIdentity: () => OWNER_IDENTITY,
      openFile(path, flags, mode) {
        const fd = NODE_PROCESS_FILE_LOCK_RUNTIME.openFile(path, flags, mode);
        fileDescriptors.set(fd, path);
        return fd;
      },
      syncFile(fd) {
        syncedPaths.push(fileDescriptors.get(fd) ?? '<unknown>');
        NODE_PROCESS_FILE_LOCK_RUNTIME.syncFile(fd);
      },
      closeFile(fd) {
        NODE_PROCESS_FILE_LOCK_RUNTIME.closeFile(fd);
        fileDescriptors.delete(fd);
      },
    });

    const result = tryAcquireProcessFileLock(lockPath, {
      kind: 'reader-admission',
      pid: OWNER_IDENTITY.pid,
      directoryDurability: 'recoverable',
      runtime,
    });

    expect(result.kind).toBe('acquired');
    expect(syncedPaths).toEqual([expect.stringMatching(/\.candidate$/)]);
    if (result.kind === 'acquired') expect(result.lock.release()).toBe(true);
    expect(syncedPaths).toHaveLength(1);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('removes an exclusively created record when a synchronous ownership write fails', () => {
    const lockPath = temporaryLockPath();
    let injected = false;
    const crashingRuntime = lockRuntime({
      writeFile() {
        injected = true;
        throw Object.assign(new Error('simulated ownership write failure'), { code: 'EIO' });
      },
    });

    expect(() =>
      tryAcquireProcessFileLock(lockPath, {
        kind: 'test',
        processIdentity: null,
        runtime: crashingRuntime,
      }),
    ).toThrow(/write failure/);
    expect(injected).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(candidateNames(lockPath)).toEqual([]);
  });

  it('never publishes an incomplete record when a process crashes before exclusive publication', () => {
    const lockPath = temporaryLockPath();
    const candidatePath = `${lockPath}.abandoned.candidate`;
    writeFileSync(candidatePath, '');

    const recovered = tryAcquireProcessFileLock(lockPath, {
      kind: 'test',
      processIdentity: null,
    });

    expect(recovered.kind).toBe('acquired');
    expect(readProcessFileLock(lockPath).state).toBe('valid');
    expect(existsSync(candidatePath)).toBe(true);
    if (recovered.kind === 'acquired') recovered.lock.release();
  });

  it('removes a complete record when its ownership flush fails synchronously', () => {
    const lockPath = temporaryLockPath();
    const runtime = lockRuntime({
      syncFile() {
        throw Object.assign(new Error('simulated file flush failure'), { code: 'EIO' });
      },
    });

    expect(() =>
      tryAcquireProcessFileLock(lockPath, {
        kind: 'test',
        processIdentity: null,
        runtime,
      }),
    ).toThrow(/flush failure/);
    expect(existsSync(lockPath)).toBe(false);
    expect(candidateNames(lockPath)).toEqual([]);
  });

  it('leaves no public owner when exclusive link publication is unsupported', () => {
    const lockPath = temporaryLockPath();
    const runtime = lockRuntime({
      linkFile() {
        throw Object.assign(new Error('simulated hard-link failure'), { code: 'EPERM' });
      },
    });

    expect(() =>
      tryAcquireProcessFileLock(lockPath, {
        kind: 'test',
        processIdentity: null,
        runtime,
      }),
    ).toThrow(/hard-link failure/);
    expect(existsSync(lockPath)).toBe(false);
    expect(candidateNames(lockPath)).toEqual([]);
  });

  it('does not reclaim truncated public JSON after a forward civil-clock jump', () => {
    const lockPath = temporaryLockPath();
    writeFileSync(lockPath, '{"protocol":');

    const duringGrace = tryAcquireProcessFileLock(lockPath, {
      kind: 'test',
      processIdentity: null,
      creationGraceMs: 60_000,
      runtime: lockRuntime({ wallNow: () => Date.now() }),
    });
    expect(duringGrace.kind).toBe('contended');
    expect(readFileSync(lockPath, 'utf8')).toBe('{"protocol":');

    const afterJump = tryAcquireProcessFileLock(lockPath, {
      kind: 'test',
      processIdentity: null,
      creationGraceMs: 60_000,
      runtime: lockRuntime({ wallNow: () => Date.now() + 86_400_000 }),
    });
    expect(afterJump.kind).toBe('contended');
    expect(readFileSync(lockPath, 'utf8')).toBe('{"protocol":');
  });

  it('fails closed for an ownerless public record regardless of civil age', () => {
    const lockPath = temporaryLockPath();
    writeFileSync(lockPath, '');
    const runtime = lockRuntime({
      wallNow: () => Date.now() + 365 * 86_400_000,
      isProcessAlive: () => true,
      readProcessIdentity: () => null,
    });

    const first = tryAcquireProcessFileLock(lockPath, {
      kind: 'test',
      processIdentity: null,
      creationGraceMs: 0,
      runtime,
    });
    const second = tryAcquireProcessFileLock(lockPath, {
      kind: 'test',
      processIdentity: null,
      creationGraceMs: 0,
      runtime,
    });

    expect(first.kind).toBe('contended');
    expect(second.kind).toBe('contended');
    expect(readFileSync(lockPath, 'utf8')).toBe('');
  });

  it('recovers a reclaim guard only when its recorded process is dead', () => {
    const lockPath = temporaryLockPath();
    writeFileSync(lockPath, `${JSON.stringify(record('dead-owner', OWNER_IDENTITY))}\n`);
    writeFileSync(`${lockPath}.reclaim`, `${JSON.stringify(record('dead-guard', OWNER_IDENTITY))}\n`);

    const result = tryAcquireProcessFileLock(lockPath, {
      kind: 'test',
      processIdentity: null,
      runtime: lockRuntime({ isProcessAlive: () => false }),
    });

    expect(result.kind).toBe('acquired');
    expect(existsSync(`${lockPath}.reclaim`)).toBe(false);
    if (result.kind === 'acquired') result.lock.release();
  });

  it('does not reclaim a live owner when its process instance cannot be verified', () => {
    const lockPath = temporaryLockPath();
    writeFileSync(lockPath, `${JSON.stringify({ pid: OWNER_IDENTITY.pid })}\n`);

    const result = tryAcquireProcessFileLock(lockPath, {
      kind: 'test',
      processIdentity: null,
      creationGraceMs: 0,
      parseLegacy: decodeLegacyPidLock,
      runtime: lockRuntime({
        wallNow: () => Date.now() + 1_000,
        isProcessAlive: () => true,
        readProcessIdentity: () => null,
      }),
    });

    expect(result.kind).toBe('contended');
    expect(readProcessFileLock(lockPath, { parseLegacy: decodeLegacyPidLock }).state).toBe('legacy');
  });

  it('reclaims a live PID slot when the recorded process birth identity no longer matches', () => {
    const lockPath = temporaryLockPath();
    writeFileSync(lockPath, `${JSON.stringify(record('old-token', OWNER_IDENTITY))}\n`);

    const result = tryAcquireProcessFileLock(lockPath, {
      kind: 'test',
      pid: SUCCESSOR_IDENTITY.pid,
      processIdentity: SUCCESSOR_IDENTITY,
      runtime: lockRuntime({
        isProcessAlive: () => true,
        readProcessIdentity: () => SUCCESSOR_IDENTITY,
      }),
    });

    expect(result.kind).toBe('acquired');
    if (result.kind === 'acquired') {
      expect(result.lock.record.token).not.toBe('old-token');
      result.lock.release();
    }
  });

  it('does not let an old owner release a successor record', () => {
    const lockPath = temporaryLockPath();
    const first = tryAcquireProcessFileLock(lockPath, {
      kind: 'test',
      pid: OWNER_IDENTITY.pid,
      processIdentity: OWNER_IDENTITY,
      runtime: lockRuntime({ randomToken: () => 'first-token' }),
    });
    expect(first.kind).toBe('acquired');
    unlinkSync(lockPath);
    const successor = tryAcquireProcessFileLock(lockPath, {
      kind: 'test',
      pid: SUCCESSOR_IDENTITY.pid,
      processIdentity: SUCCESSOR_IDENTITY,
      runtime: lockRuntime({ randomToken: () => 'successor-token' }),
    });
    expect(successor.kind).toBe('acquired');

    if (first.kind === 'acquired') expect(first.lock.release()).toBe(false);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(expect.objectContaining({ token: 'successor-token' }));
    if (successor.kind === 'acquired') successor.lock.release();
  });

  it('rejects direct release when the token does not match', () => {
    const lockPath = temporaryLockPath();
    const acquired = tryAcquireProcessFileLock(lockPath, {
      kind: 'test',
      pid: OWNER_IDENTITY.pid,
      processIdentity: OWNER_IDENTITY,
      runtime: lockRuntime({ randomToken: () => 'owner-token' }),
    });
    expect(acquired.kind).toBe('acquired');

    expect(
      releaseOwnedProcessFileLock(
        lockPath,
        {
          pid: OWNER_IDENTITY.pid,
          token: 'other-token',
          processIdentity: OWNER_IDENTITY,
        },
        lockRuntime(),
      ),
    ).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
    if (acquired.kind === 'acquired') acquired.lock.release();
  });

  it('retains a successor that appears between stale observation and guarded recheck', () => {
    const lockPath = temporaryLockPath();
    writeFileSync(lockPath, `${JSON.stringify(record('old-token', OWNER_IDENTITY))}\n`);
    const observed = readProcessFileLock(lockPath);
    let targetReads = 0;
    const successor = `${JSON.stringify(record('successor-token', SUCCESSOR_IDENTITY))}\n`;
    const runtime = lockRuntime({
      wallNow: () => Date.now() + 1_000,
      readFile(path) {
        if (path === lockPath && targetReads++ === 0) {
          unlinkSync(lockPath);
          writeFileSync(lockPath, successor);
        }
        return NODE_PROCESS_FILE_LOCK_RUNTIME.readFile(path);
      },
      isProcessAlive: (pid) => pid === SUCCESSOR_IDENTITY.pid,
      readProcessIdentity: () => SUCCESSOR_IDENTITY,
    });

    expect(
      reclaimProcessFileLock(lockPath, observed, {
        creationGraceMs: 0,
        runtime,
      }),
    ).toBe(false);
    expect(readFileSync(lockPath, 'utf8')).toBe(successor);
  });
});

function temporaryLockPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'scip-query-process-lock-'));
  tempDirs.push(directory);
  return join(directory, 'owner.lock');
}

function candidateNames(lockPath: string): string[] {
  const directory = lockPath.slice(0, lockPath.lastIndexOf('/'));
  return readdirSync(directory).filter((name) => name.endsWith('.candidate'));
}

function lockRuntime(overrides: Partial<ProcessFileLockRuntime> = {}): ProcessFileLockRuntime {
  return {
    ...NODE_PROCESS_FILE_LOCK_RUNTIME,
    isProcessAlive: () => false,
    readProcessIdentity: () => null,
    ...overrides,
  };
}

function record(token: string, processIdentity: ProcessIdentity): ProcessFileLockRecord {
  return {
    protocol: PROCESS_FILE_LOCK_PROTOCOL,
    version: PROCESS_FILE_LOCK_VERSION,
    kind: 'test',
    pid: processIdentity.pid,
    token,
    processIdentity,
    startedAt: '2026-07-25T00:00:00.000Z',
  };
}
