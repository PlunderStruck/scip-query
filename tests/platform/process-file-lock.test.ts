import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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
  type LegacyProcessLockDecoder,
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
const parseLegacyPid: LegacyProcessLockDecoder = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const pid = (value as { pid?: unknown }).pid;
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? { pid } : null;
};

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('process file lock protocol', () => {
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
        events.push(`open:${path === lockPath ? 'lock' : 'directory'}`);
        return fd;
      },
      writeFile(fd, bytes, offset, length) {
        events.push('write');
        return NODE_PROCESS_FILE_LOCK_RUNTIME.writeFile(fd, bytes, offset, length);
      },
      syncFile(fd) {
        events.push(`sync:${fileDescriptors.get(fd) === lockPath ? 'lock' : 'directory'}`);
        NODE_PROCESS_FILE_LOCK_RUNTIME.syncFile(fd);
      },
      closeFile(fd) {
        NODE_PROCESS_FILE_LOCK_RUNTIME.closeFile(fd);
        fileDescriptors.delete(fd);
      },
      removeFile(path) {
        events.push('remove');
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
    expect(events).toEqual(['open:lock', 'write', 'sync:lock', 'open:directory', 'sync:directory']);
    if (result.kind === 'acquired') expect(result.lock.release()).toBe(true);
    expect(events.slice(-3)).toEqual(['remove', 'open:directory', 'sync:directory']);
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
  });

  it('recovers an empty record left by a process crash after exclusive create', () => {
    const lockPath = temporaryLockPath();
    writeFileSync(lockPath, '');

    const recovered = tryAcquireProcessFileLock(lockPath, {
      kind: 'test',
      processIdentity: null,
      creationGraceMs: 0,
      runtime: lockRuntime({ wallNow: () => Date.now() + 1_000 }),
    });

    expect(recovered.kind).toBe('acquired');
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
  });

  it('does not reclaim truncated JSON during creation grace and does reclaim it afterward', () => {
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

    const afterGrace = tryAcquireProcessFileLock(lockPath, {
      kind: 'test',
      processIdentity: null,
      creationGraceMs: 60_000,
      runtime: lockRuntime({ wallNow: () => Date.now() + 60_001 }),
    });
    expect(afterGrace.kind).toBe('acquired');
    if (afterGrace.kind === 'acquired') afterGrace.lock.release();
  });

  it('serializes malformed recovery so only one reclaimer becomes owner', () => {
    const lockPath = temporaryLockPath();
    writeFileSync(lockPath, '');
    const runtime = lockRuntime({
      wallNow: () => Date.now() + 1_000,
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

    expect(first.kind).toBe('acquired');
    expect(second.kind).toBe('contended');
    if (first.kind === 'acquired') first.lock.release();
  });

  it('recovers an abandoned malformed reclaim guard before reclaiming the target', () => {
    const lockPath = temporaryLockPath();
    writeFileSync(lockPath, '');
    writeFileSync(`${lockPath}.reclaim`, '');

    const result = tryAcquireProcessFileLock(lockPath, {
      kind: 'test',
      processIdentity: null,
      creationGraceMs: 0,
      runtime: lockRuntime({ wallNow: () => Date.now() + 1_000 }),
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
      parseLegacy: parseLegacyPid,
      runtime: lockRuntime({
        wallNow: () => Date.now() + 1_000,
        isProcessAlive: () => true,
        readProcessIdentity: () => null,
      }),
    });

    expect(result.kind).toBe('contended');
    expect(readProcessFileLock(lockPath, { parseLegacy: parseLegacyPid }).state).toBe('legacy');
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
    writeFileSync(lockPath, '');
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
      isProcessAlive: () => true,
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
