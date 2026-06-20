import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { RemovedRangeIndex, type CleanupBatch } from '../src/queries/cleanup/cleanup-plan.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyCleanupBatches,
  cleanupVerificationFailures,
  createCleanupPatch,
  deleteLineRanges,
  detectCheckers,
  errorKey,
  selectCleanupBatches,
} from '../src/runtime/cleanup-verify.js';

describe('cleanup plan removed-range index', () => {
  it('answers membership per file and line range', () => {
    const index = new RemovedRangeIndex();
    index.add({ file: 'src/a.ts', startLine: 10, endLine: 20 });
    index.add({ file: 'src/a.ts', startLine: 40, endLine: 45 });
    index.add({ file: 'src/b.ts', startLine: 0, endLine: 5 });

    expect(index.contains('src/a.ts', 10)).toBe(true);
    expect(index.contains('src/a.ts', 20)).toBe(true);
    expect(index.contains('src/a.ts', 21)).toBe(false);
    expect(index.contains('src/a.ts', 42)).toBe(true);
    expect(index.contains('src/b.ts', 3)).toBe(true);
    expect(index.contains('src/c.ts', 3)).toBe(false);
  });
});

describe('verification line deletion', () => {
  it('removes inclusive 0-indexed ranges, handling overlap and out-of-bounds', () => {
    const content = ['l0', 'l1', 'l2', 'l3', 'l4', 'l5'].join('\n');

    expect(deleteLineRanges(content, [{ start: 1, end: 2 }])).toBe('l0\nl3\nl4\nl5');
    expect(deleteLineRanges(content, [{ start: 1, end: 3 }, { start: 2, end: 4 }])).toBe('l0\nl5');
    expect(deleteLineRanges(content, [{ start: 4, end: 99 }])).toBe('l0\nl1\nl2\nl3');
    expect(deleteLineRanges(content, [])).toBe(content);
  });

  it('extends truncated ranges until brackets balance so statements are never bisected', () => {
    const content = [
      'const keep = 1;',
      'export const dead = items.map((item) => {', // index says 1-1, real extent 1-3
      '  return item;',
      '});',
      'const alsoKeep = 2;',
    ].join('\n');

    expect(deleteLineRanges(content, [{ start: 1, end: 1 }]))
      .toBe('const keep = 1;\nconst alsoKeep = 2;');
    // Strings containing brackets must not confuse the balance.
    const tricky = ['const a = "}{";', 'const dead = [', '  1,', '];'].join('\n');
    expect(deleteLineRanges(tricky, [{ start: 1, end: 1 }])).toBe('const a = "}{";');
  });
});

describe('verification error identity', () => {
  it('is position-independent so shifted pre-existing errors still match the baseline', () => {
    expect(errorKey("src/app.ts(12,8): error TS1259: Module 'x' can only be default-imported"))
      .toBe(errorKey("src/app.ts(99,8): error TS1259: Module 'x' can only be default-imported"));
    expect(errorKey('error[E0432]: unresolved import --> src/lib.rs:4:5'))
      .toBe(errorKey('error[E0432]: unresolved import --> src/lib.rs:9:1'));
    expect(errorKey("a.ts(1,1): error TS2304: Cannot find name 'x'"))
      .not.toBe(errorKey("a.ts(1,1): error TS2304: Cannot find name 'y'"));
  });
});

describe('cleanup patch and apply helpers', () => {
  function sampleBatch(): CleanupBatch {
    return {
      depth: 0,
      loc: 1,
      filesEmptied: [],
      entries: [{
        symbol: 'scip-typescript npm pkg 1.0.0 src/`a.ts`/dead().',
        shortName: 'src:a:dead()',
        file: 'src/a.ts',
        startLine: 1,
        endLine: 1,
        loc: 1,
        evidence: 'graph-fact',
      }],
    };
  }

  it('creates a git patch from the same deletion primitive used by apply', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-cleanup-patch-test-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'a.ts'), 'export const keep = 1;\nexport const dead = 2;\n');
      execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: root });
      execFileSync('git', ['add', '.'], { cwd: root });
      execFileSync('git', ['commit', '-m', 'initial'], { cwd: root, stdio: 'ignore' });

      const patch = createCleanupPatch(root, [sampleBatch()]);

      expect(patch).toContain('diff --git a/src/a.ts b/src/a.ts');
      expect(patch).toContain('-export const dead = 2;');
      expect(readFileSync(join(root, 'src', 'a.ts'), 'utf-8')).toContain('dead');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('applies selected cleanup batches to the working tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-cleanup-apply-test-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'a.ts'), 'export const keep = 1;\nexport const dead = 2;\n');

      applyCleanupBatches(root, [sampleBatch()]);

      expect(readFileSync(join(root, 'src', 'a.ts'), 'utf-8')).toBe('export const keep = 1;\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('selects batches and reports verification policy failures', () => {
    const batch = sampleBatch();
    const plan = { batches: [batch], totalSymbols: 1, totalLoc: 1, blocked: [] };

    expect(selectCleanupBatches(plan, { batch: 0 })).toEqual([batch]);
    expect(selectCleanupBatches(plan, { batch: 9 })).toEqual([]);
    expect(cleanupVerificationFailures({
      checkers: ['tsc --noEmit'],
      uncoveredFiles: [],
      baselineErrors: 0,
      dirtyOverlap: ['src/a.ts'],
      batches: [{ depth: 0, status: 'verified' }],
    }, [batch])).toContain('Plan files are dirty in the working tree: src/a.ts.');
    expect(cleanupVerificationFailures({
      checkers: ['tsc --noEmit'],
      uncoveredFiles: [],
      baselineErrors: 0,
      dirtyOverlap: ['src/a.ts'],
      batches: [{ depth: 0, status: 'verified' }],
    }, [batch], { allowDirty: true })).toEqual([]);
  });
});

describe('checker detection', () => {
  it('detects per-language checkers from project manifests', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-checkers-'));
    try {
      expect(detectCheckers(root)).toEqual([]);

      writeFileSync(join(root, 'go.mod'), 'module example.com/m');
      writeFileSync(join(root, 'Cargo.toml'), '[package]');
      const labels = detectCheckers(root).map((checker) => checker.label);
      expect(labels.some((label) => label.startsWith('go build'))).toBe(true);
      expect(labels.some((label) => label.startsWith('cargo check'))).toBe(true);

      const covered = detectCheckers(root).flatMap((checker) => checker.coversExtensions);
      expect(covered).toContain('.go');
      expect(covered).toContain('.rs');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
