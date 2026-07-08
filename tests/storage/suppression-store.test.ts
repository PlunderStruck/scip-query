import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readSuppressionDir,
  suppressionDirPath,
  suppressionFileName,
  writeSuppressionFile,
} from '../../src/storage/suppression-store.js';

const roots: string[] = [];

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'scipq-suppression-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('suppressionFileName', () => {
  it('uses the finding id when present', () => {
    expect(suppressionFileName({ id: 'SQABC123DEF456', reason: 'x' })).toBe('SQABC123DEF456.json');
  });

  it('derives a stable hash name for check-level suppressions', () => {
    const first = suppressionFileName({ check: 'echo', file: 'src/a.ts', reason: 'x' });
    const second = suppressionFileName({ check: 'echo', file: 'src/a.ts', reason: 'different reason' });
    expect(first).toBe(second);
    expect(first).toMatch(/^CHECK-[0-9A-F]{12}\.json$/);
    expect(suppressionFileName({ check: 'echo', file: 'src/b.ts', reason: 'x' })).not.toBe(first);
  });
});

describe('writeSuppressionFile / readSuppressionDir', () => {
  it('round-trips a suppression and stamps createdAt', () => {
    const root = createRoot();
    const now = new Date('2026-07-07T12:00:00.000Z');

    const result = writeSuppressionFile(root, { id: 'SQABC123DEF456', check: 'echo', reason: 'fixture overlap' }, now);
    expect(result.path).toBe(join(suppressionDirPath(root), 'SQABC123DEF456.json'));

    const read = readSuppressionDir(root);
    expect(read.warnings).toEqual([]);
    expect(read.suppressions).toEqual([
      { id: 'SQABC123DEF456', check: 'echo', reason: 'fixture overlap', createdAt: '2026-07-07T12:00:00.000Z' },
    ]);
  });

  it('re-suppressing the same finding overwrites rather than duplicates', () => {
    const root = createRoot();
    writeSuppressionFile(root, { id: 'SQAAA', reason: 'first' });
    writeSuppressionFile(root, { id: 'SQAAA', reason: 'second' });

    const read = readSuppressionDir(root);
    expect(read.suppressions).toHaveLength(1);
    expect(read.suppressions[0].reason).toBe('second');
  });

  it('rejects writes without a reason or without an id/check', () => {
    const root = createRoot();
    expect(() => writeSuppressionFile(root, { id: 'SQAAA', reason: '  ' })).toThrow(/reason/);
    expect(() => writeSuppressionFile(root, { reason: 'valid' })).toThrow(/id or a check/);
  });

  it('returns empty for a missing directory', () => {
    expect(readSuppressionDir(createRoot())).toEqual({ suppressions: [], warnings: [] });
  });

  it('skips malformed and invalid files with warnings, keeps valid ones', () => {
    const root = createRoot();
    const dir = suppressionDirPath(root);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'broken.json'), '{ not json');
    writeFileSync(join(dir, 'no-reason.json'), JSON.stringify({ id: 'SQBBB' }));
    writeFileSync(join(dir, 'no-target.json'), JSON.stringify({ reason: 'reason without target' }));
    writeFileSync(join(dir, 'notes.txt'), 'ignored entirely');
    writeSuppressionFile(root, { id: 'SQCCC', reason: 'valid' });

    const read = readSuppressionDir(root);
    expect(read.suppressions.map((s) => s.id)).toEqual(['SQCCC']);
    expect(read.warnings).toHaveLength(3);
    expect(read.warnings.join('\n')).toMatch(/malformed JSON/);
    expect(read.warnings.join('\n')).toMatch(/missing reason/);
    expect(read.warnings.join('\n')).toMatch(/id or a check/);
  });

  it('writes files the config validator accepts as suppression shapes', () => {
    const root = createRoot();
    writeSuppressionFile(root, { id: 'SQDDD', file: 'src/a.ts', reason: 'r', expiresAt: '2027-01-01' });
    const raw = JSON.parse(readFileSync(join(suppressionDirPath(root), 'SQDDD.json'), 'utf-8'));
    expect(Object.keys(raw).sort()).toEqual(['createdAt', 'expiresAt', 'file', 'id', 'reason']);
  });
});
