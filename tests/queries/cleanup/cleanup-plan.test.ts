import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { RemovedRangeIndex, type CleanupBatch } from '../../../src/queries/cleanup/cleanup-plan.js';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyCleanupBatches,
  cleanupVerificationFailures,
  createCleanupPatch,
  decideBatchStatus,
  deleteLineRanges,
  describeCleanupBatches,
  detectCheckers,
  errorKey,
  inspectWorkingTree,
  parseCheckerDiagnostics,
  selectCleanupBatches,
  verifyCleanupPlan,
} from '../../../src/runtime/cleanup-verify.js';

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
  it('keeps later batch ranges relative to the original source in the same file', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-cleanup-batch-lines-'));
    try {
      const path = join(root, 'functions.ts');
      writeFileSync(
        path,
        'const keepA = 1;\nconst removeA = 2;\nconst keepB = 3;\nconst removeB = 4;\nconst keepC = 5;\n',
      );
      const batches: CleanupBatch[] = [1, 3].map((line, depth) => ({
        depth,
        loc: 1,
        filesEmptied: [],
        entries: [
          {
            symbol: `remove${depth}`,
            shortName: `remove${depth}`,
            file: 'functions.ts',
            startLine: line,
            endLine: line,
            loc: 1,
            evidence: 'graph-fact',
          },
        ],
      }));
      applyCleanupBatches(root, batches);
      expect(readFileSync(path, 'utf8')).toBe('const keepA = 1;\nconst keepB = 3;\nconst keepC = 5;\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('removes inclusive 0-indexed ranges, handling overlap and out-of-bounds', () => {
    const content = ['l0', 'l1', 'l2', 'l3', 'l4', 'l5'].join('\n');

    expect(deleteLineRanges(content, [{ start: 1, end: 2 }])).toBe('l0\nl3\nl4\nl5');
    expect(
      deleteLineRanges(content, [
        { start: 1, end: 3 },
        { start: 2, end: 4 },
      ]),
    ).toBe('l0\nl5');
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

    expect(deleteLineRanges(content, [{ start: 1, end: 1 }])).toBe('const keep = 1;\nconst alsoKeep = 2;');
    // Strings containing brackets must not confuse the balance.
    const tricky = ['const a = "}{";', 'const dead = [', '  1,', '];'].join('\n');
    expect(deleteLineRanges(tricky, [{ start: 1, end: 1 }])).toBe('const a = "}{";');
  });
});

describe('verification error identity', () => {
  it('is position-independent so shifted pre-existing errors still match the baseline', () => {
    expect(errorKey("src/app.ts(12,8): error TS1259: Module 'x' can only be default-imported")).toBe(
      errorKey("src/app.ts(99,8): error TS1259: Module 'x' can only be default-imported"),
    );
    expect(errorKey('error[E0432]: unresolved import --> src/lib.rs:4:5')).toBe(
      errorKey('error[E0432]: unresolved import --> src/lib.rs:9:1'),
    );
    expect(errorKey("a.ts(1,1): error TS2304: Cannot find name 'x'")).not.toBe(
      errorKey("a.ts(1,1): error TS2304: Cannot find name 'y'"),
    );
  });

  it('treats increased same-text errors and unparsed checker failures as batch failures', () => {
    expect(decideBatchStatus({ ok: false, exitCode: 1, outputTail: ['undefined: foo'] }, [], [])).toEqual({
      status: 'failed',
      reason: 'checker exited 1 with unparsed output',
      errors: ['undefined: foo'],
    });

    expect(
      decideBatchStatus(
        { ok: false, exitCode: 1 },
        ["a.ts(1,1): error TS2304: Cannot find name 'x'"],
        ["a.ts(2,1): error TS2304: Cannot find name 'x'", "b.ts(3,1): error TS2304: Cannot find name 'x'"],
      ),
    ).toEqual({
      status: 'failed',
      reason: 'checker reported new errors',
      errors: ["b.ts(3,1): error TS2304: Cannot find name 'x'"],
    });

    expect(
      decideBatchStatus(
        { ok: true, exitCode: 0 },
        ["a.ts(1,1): error TS2304: Cannot find name 'x'"],
        ["a.ts(2,1): error TS2304: Cannot find name 'x'"],
      ),
    ).toEqual({ status: 'verified', reason: 'checker passed', errors: [] });
  });
});

describe('working-tree inspection contract', () => {
  it.each([
    ['nonzero exit', Object.assign(new Error('git failed'), { status: 128 }), 'exited with status 128'],
    ['timeout', Object.assign(new Error('git timed out'), { code: 'ETIMEDOUT', killed: true }), 'timed out'],
    ['signal', Object.assign(new Error('git was killed'), { signal: 'SIGKILL' }), 'terminated by SIGKILL'],
    ['output overflow', Object.assign(new Error('stdout maxBuffer exceeded'), { code: 'ENOBUFS' }), 'output limit'],
  ])('returns unavailable for %s instead of an empty dirty-file proof', (_label, failure, expectedReason) => {
    expect(
      inspectWorkingTree('/repo', {
        readWorkingTreeStatus: () => {
          throw failure;
        },
      }),
    ).toEqual({
      state: 'unavailable',
      reason: expect.stringContaining(expectedReason),
    });
  });

  it('propagates unavailable inspection through verification and blocks independently of allowDirty', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-cleanup-unavailable-test-'));
    try {
      const verification = verifyCleanupPlan(
        root,
        { batches: [], totalSymbols: 0, totalLoc: 0, blocked: [] },
        {
          workingTreeRuntime: {
            readWorkingTreeStatus: () => {
              throw Object.assign(new Error('git timed out'), { code: 'ETIMEDOUT', killed: true });
            },
          },
        },
      );

      expect(verification.workingTree).toEqual({
        state: 'unavailable',
        reason: expect.stringContaining('timed out'),
      });
      expect(verification.dirtyWorkingTree).toEqual([]);
      expect(verification.dirtyOverlap).toEqual([]);

      const otherwiseVerified = {
        ...verification,
        checkers: ['tsc --noEmit'],
        batches: [{ depth: 0, status: 'verified' as const }],
      };
      const selected: CleanupBatch[] = [
        {
          depth: 0,
          loc: 1,
          filesEmptied: [],
          entries: [
            {
              symbol: 'scip-typescript npm pkg 1.0.0 src/`a.ts`/dead().',
              shortName: 'src:a:dead()',
              file: 'src/a.ts',
              startLine: 1,
              endLine: 1,
              loc: 1,
              currentFanIn: 0,
              becomesDeadAfter: [],
              history: null,
            },
          ],
        },
      ];
      expect(cleanupVerificationFailures(otherwiseVerified, selected, { allowDirty: true })).toEqual(
        expect.arrayContaining([expect.stringContaining('Working-tree inspection is unavailable')]),
      );
      expect(
        cleanupVerificationFailures(otherwiseVerified, selected, {
          allowDirty: true,
          allowUnknownWorkingTree: true,
        }),
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('checker diagnostic parsing', () => {
  it('parses tsc, go, and ruff diagnostics into stable structured errors', () => {
    expect(
      parseCheckerDiagnostics('tsc --noEmit', "src/app.ts(12,8): error TS2304: Cannot find name 'missing'.\n")
        .diagnostics[0],
    ).toMatchObject({
      file: 'src/app.ts',
      line: 12,
      column: 8,
      code: 'TS2304',
      parseBasis: 'tsc',
    });

    expect(
      parseCheckerDiagnostics('go build ./...', 'main.go:10:2: undefined: missing\n').diagnostics[0],
    ).toMatchObject({
      file: 'main.go',
      line: 10,
      column: 2,
      message: 'undefined: missing',
      parseBasis: 'go',
    });

    const ruff = parseCheckerDiagnostics(
      'ruff check --select E9,F821,F822',
      JSON.stringify([
        { filename: 'pkg/app.py', location: { row: 4, column: 9 }, code: 'F821', message: 'Undefined name `x`' },
      ]),
    );
    expect(ruff.diagnostics[0]).toMatchObject({
      file: 'pkg/app.py',
      line: 4,
      column: 9,
      code: 'F821',
      parseBasis: 'ruff-json',
    });
  });

  it('parses cargo and clj-kondo JSON diagnostics and labels heuristic fallback', () => {
    const cargoLine = JSON.stringify({
      reason: 'compiler-message',
      message: {
        level: 'error',
        message: 'unresolved import `crate::missing`',
        code: { code: 'E0432' },
        spans: [{ is_primary: true, file_name: 'src/lib.rs', line_start: 3, column_start: 5 }],
      },
    });
    expect(
      parseCheckerDiagnostics('cargo check --quiet --manifest-path Cargo.toml', cargoLine).diagnostics[0],
    ).toMatchObject({
      file: 'src/lib.rs',
      line: 3,
      column: 5,
      code: 'E0432',
      parseBasis: 'cargo-json',
    });

    const kondo = parseCheckerDiagnostics(
      'clj-kondo --lint .',
      JSON.stringify({
        findings: [
          {
            level: 'error',
            filename: 'src/core.clj',
            row: 7,
            col: 3,
            type: 'unresolved-symbol',
            message: 'Unresolved symbol: x',
          },
        ],
      }),
    );
    expect(kondo.diagnostics[0]).toMatchObject({
      file: 'src/core.clj',
      line: 7,
      column: 3,
      code: 'unresolved-symbol',
      parseBasis: 'clj-kondo-json',
    });

    const heuristic = parseCheckerDiagnostics('custom checker', 'fatal error: nope\n');
    expect(heuristic).toEqual({
      parseBasis: 'heuristic',
      diagnostics: [{ file: '', message: 'fatal error: nope', parseBasis: 'heuristic' }],
    });
  });
});

describe('cleanup patch and apply helpers', () => {
  function sampleBatch(): CleanupBatch {
    return {
      depth: 0,
      loc: 1,
      filesEmptied: [],
      entries: [
        {
          symbol: 'scip-typescript npm pkg 1.0.0 src/`a.ts`/dead().',
          shortName: 'src:a:dead()',
          file: 'src/a.ts',
          startLine: 1,
          endLine: 1,
          loc: 1,
          evidence: 'graph-fact',
        },
      ],
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

  it('verifies from committed HEAD without writing linked-worktree metadata', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-cleanup-readonly-git-test-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'a.ts'), 'export const keep = 1;\nexport const dead = 2;\n');
      writeFileSync(join(root, 'tsconfig.json'), '{}\n');
      execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: root });
      execFileSync('git', ['add', '.'], { cwd: root });
      execFileSync('git', ['commit', '-m', 'initial'], { cwd: root, stdio: 'ignore' });

      mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
      const tsc = join(root, 'node_modules', '.bin', 'tsc');
      writeFileSync(tsc, '#!/bin/sh\nexit 0\n');
      chmodSync(tsc, 0o755);
      chmodSync(join(root, '.git'), 0o555);

      const verification = verifyCleanupPlan(root, {
        batches: [sampleBatch()],
        totalSymbols: 1,
        totalLoc: 1,
        blocked: [],
      });

      expect(verification.unavailableReason).toBeUndefined();
      expect(verification.batches).toEqual([{ depth: 0, status: 'verified' }]);
      expect(existsSync(join(root, '.git', 'worktrees'))).toBe(false);
      expect(readFileSync(join(root, 'src', 'a.ts'), 'utf-8')).toContain('dead');
    } finally {
      if (existsSync(join(root, '.git'))) chmodSync(join(root, '.git'), 0o755);
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

  it('previews the exact cleanup selection without mutating source files', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-cleanup-preview-test-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      const source = 'export const keep = 1;\nexport const dead = 2;\n';
      writeFileSync(join(root, 'src', 'a.ts'), source);

      const described = describeCleanupBatches([sampleBatch()], { dryRun: true });
      const applied = applyCleanupBatches(root, [sampleBatch()], { dryRun: true });

      expect(applied).toEqual(described);
      expect(applied).toEqual({
        dryRun: true,
        batches: 1,
        symbols: 1,
        loc: 1,
        files: ['src/a.ts'],
        filesEmptied: [],
        targets: [
          {
            batch: 0,
            file: 'src/a.ts',
            startLine: 1,
            endLine: 1,
            loc: 1,
            symbol: 'src:a:dead()',
          },
        ],
      });
      expect(readFileSync(join(root, 'src', 'a.ts'), 'utf-8')).toBe(source);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('selects batches and reports verification policy failures', () => {
    const batch = sampleBatch();
    const plan = { batches: [batch], totalSymbols: 1, totalLoc: 1, blocked: [] };

    expect(selectCleanupBatches(plan, { batch: 0 })).toEqual([batch]);
    expect(selectCleanupBatches(plan, { batch: 9 })).toEqual([]);
    expect(
      cleanupVerificationFailures(
        {
          checkers: ['tsc --noEmit'],
          uncoveredFiles: [],
          baselineErrors: 0,
          workingTree: { state: 'known', files: ['src/a.ts'] },
          dirtyOverlap: ['src/a.ts'],
          dirtyWorkingTree: ['src/a.ts'],
          batches: [{ depth: 0, status: 'verified' }],
        },
        [batch],
      ),
    ).toContain('Plan files are dirty in the working tree: src/a.ts.');
    expect(
      cleanupVerificationFailures(
        {
          checkers: ['tsc --noEmit'],
          uncoveredFiles: [],
          baselineErrors: 0,
          workingTree: { state: 'known', files: ['src/a.ts'] },
          dirtyOverlap: ['src/a.ts'],
          dirtyWorkingTree: ['src/a.ts'],
          batches: [{ depth: 0, status: 'verified' }],
        },
        [batch],
        { allowDirty: true },
      ),
    ).toEqual([]);
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

  it('detects local clj-kondo for Clojure projects', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-clojure-checkers-'));
    try {
      writeFileSync(join(root, 'deps.edn'), '{}\n');
      mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
      const localKondo = join(root, 'node_modules', '.bin', 'clj-kondo');
      writeFileSync(localKondo, '#!/usr/bin/env sh\nexit 0\n');
      chmodSync(localKondo, 0o755);

      const checkers = detectCheckers(root);
      const clojureChecker = checkers.find((checker) => checker.label === 'clj-kondo --lint .');

      expect(clojureChecker).toEqual(
        expect.objectContaining({
          binary: localKondo,
          args: ['--lint', '.', '--config', '{:output {:format :json}}'],
          coversExtensions: ['.clj', '.cljs', '.cljc'],
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
