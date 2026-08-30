import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cloneFileWithFallback,
  createReindexWriteTelemetry,
  recordFileClone,
  recordIncrementalWrite,
  reflinkUnavailable,
  type FileCloneRuntime,
} from '../../src/platform/file-clone.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('cloneFileWithFallback', () => {
  it('creates byte-identical output with the host clone-or-copy capability', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scip-query-clone-'));
    tempDirs.push(dir);
    const source = join(dir, 'source.bin');
    const target = join(dir, 'target.bin');
    const contents = Buffer.from('artifact bytes');
    writeFileSync(source, contents);

    const result = cloneFileWithFallback(source, target);

    expect(result.bytes).toBe(contents.length);
    if (process.platform === 'darwin') expect(result.method).toBe('reflink');
    else expect(['reflink', 'copy']).toContain(result.method);
    expect(readFileSync(target)).toEqual(contents);
  });

  it('falls back only when the filesystem reports missing reflink capability', () => {
    const clone = vi.fn<FileCloneRuntime['clone']>(() => {
      throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' });
    });
    const copy = vi.fn<FileCloneRuntime['copy']>();

    expect(cloneFileWithFallback('source', 'target', { size: () => 42, clone, copy })).toEqual({
      method: 'copy',
      bytes: 42,
    });
    expect(clone).toHaveBeenCalledWith('source', 'target');
    expect(copy).toHaveBeenCalledWith('source', 'target');
  });

  it('does not hide permission or I/O failures behind a fallback copy', () => {
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    const clone = vi.fn<FileCloneRuntime['clone']>(() => {
      throw denied;
    });
    const copy = vi.fn<FileCloneRuntime['copy']>();

    expect(() => cloneFileWithFallback('source', 'target', { size: () => 42, clone, copy })).toThrow(denied);
    expect(clone).toHaveBeenCalledOnce();
    expect(copy).not.toHaveBeenCalled();
    expect(reflinkUnavailable(denied)).toBe(false);
  });

  it('accounts reflinked and fallback-copied bytes separately', () => {
    const telemetry = createReindexWriteTelemetry();

    recordFileClone(telemetry, { method: 'reflink', bytes: 100 });
    recordFileClone(telemetry, { method: 'copy', bytes: 40 });
    recordIncrementalWrite(telemetry, 15);

    expect(telemetry).toEqual({ reflinkedBytes: 100, fallbackCopiedBytes: 40, incrementalWrittenBytes: 15 });
  });
});
