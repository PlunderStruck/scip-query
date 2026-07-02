import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { docDrift } from '../../../src/queries/cleanup/doc-drift.js';
import type { ScipDatabase } from '../../../src/storage/db.js';

let commitClock = 2_000_000_000;

function fakeDb(projectRoot: string, snapshotPaths?: string[]): ScipDatabase {
  return {
    config: { projectRoot, docs: snapshotPaths ? { snapshotPaths } : undefined },
    all: () => [],
    pathExclusionsFor: () => '',
    isIgnored: () => false,
  } as unknown as ScipDatabase;
}

function gitIn(root: string, ...args: string[]): void {
  execFileSync('git', ['-C', root, ...args], {
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 't@t.t',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 't@t.t',
      GIT_AUTHOR_DATE: `${commitClock} +0000`,
      GIT_COMMITTER_DATE: `${commitClock} +0000`,
    },
  });
}

function commitIn(root: string, message: string, files: Record<string, string>): void {
  commitClock += 60;
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(root, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-m', message, '--no-gpg-sign');
}

describe('doc-drift', () => {
  it('reports stale cited files with line references and shared citation-kind policy', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-doc-drift-dedicated-'));
    try {
      gitIn(root, 'init');
      commitIn(root, 'initial docs', {
        'README.md': [
          'Use `.scipquery.json` for declaredCouplings configuration:',
          '',
          '```json',
          '{ "declaredCouplings": [{ "files": ["src/a.ts:7"] }] }',
          '```',
          '',
        ].join('\n'),
        'src/a.ts': 'export const version = 1;\n',
      });
      commitIn(root, 'code moves on', {
        'src/a.ts': 'export const version = 2;\n',
      });

      const result = docDrift(fakeDb(root), { doc: 'README.md' });
      const subject = result.findings[0]?.subjects[0];

      expect(subject).toEqual(
        expect.objectContaining({
          file: 'src/a.ts',
          evidence: 'reference',
          citedLines: [7],
          citationKind: 'configuration-example',
          actionTier: 'support',
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports broken references but suppresses archived changelog scans by default', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-doc-drift-broken-'));
    try {
      gitIn(root, 'init');
      commitIn(root, 'initial docs', {
        'docs/guide.md': 'Current behavior lives in src/removed.ts.\n',
        'CHANGELOG.md': 'Historical note for src/removed.ts.\n',
        'src/removed.ts': 'export const old = 1;\n',
      });
      gitIn(root, 'rm', 'src/removed.ts');
      commitIn(root, 'remove stale file', {});

      const result = docDrift(fakeDb(root), { limit: 10 });

      expect(result.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            doc: 'docs/guide.md',
            brokenReferences: ['src/removed.ts'],
          }),
        ]),
      );
      expect(result.findings.map((finding) => finding.doc)).not.toContain('CHANGELOG.md');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('excludes a docs.snapshotPaths glob match from default findings, but labels it under --full', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-doc-drift-snapshot-'));
    try {
      gitIn(root, 'init');
      commitIn(root, 'initial', {
        'docs/benchmarks/2026-06-28-ledger.md': 'Snapshot of src/a.ts as of this date.\n',
        'src/a.ts': 'export const version = 1;\n',
      });
      commitIn(root, 'code moves on', { 'src/a.ts': 'export const version = 2;\n' });

      const db = fakeDb(root, ['docs/benchmarks/**']);

      const defaultResult = docDrift(db, { limit: 10 });
      expect(defaultResult.findings.map((finding) => finding.doc)).not.toContain(
        'docs/benchmarks/2026-06-28-ledger.md',
      );

      const fullResult = docDrift(db, { limit: 10, includeSnapshotExcluded: true });
      const snapshotFinding = fullResult.findings.find(
        (finding) => finding.doc === 'docs/benchmarks/2026-06-28-ledger.md',
      );
      expect(snapshotFinding?.snapshotExcluded).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // 21.2 calibration retune (2026-07-01 Vega calibration: every sampled
  // finding reported `docLastChangedAt: 0` even for docs committed the same
  // day). A doc that's staged but never committed has zero entries in the
  // git-log-derived changeTimes map — falls back to filesystem mtime
  // instead of epoch 0.
  it('falls back to filesystem mtime instead of epoch 0 for a doc with no commit-history entry', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-doc-drift-mtime-fallback-'));
    try {
      gitIn(root, 'init');
      commitIn(root, 'initial', { 'src/subject.ts': 'export const version = 1;\n' });

      // commitClock starts far in the future relative to wall-clock "now",
      // so this commit's timestamp is guaranteed to be after the doc's
      // mtime-based fallback (created and staged below) — the subject
      // change registers as "since".
      commitIn(root, 'subject changes before the doc exists', {
        'src/subject.ts': 'export const version = 2;\n',
      });

      // Staged (tracked by `git ls-files`) but never committed — no entry
      // in the commit-history scan `docDrift` relies on for docLastChangedAt.
      // `git add -A` was already run for the commits above; staging this
      // file alone here, with no further commit, keeps it uncommitted.
      mkdirSync(join(root, 'docs'), { recursive: true });
      writeFileSync(join(root, 'docs', 'new-note.md'), 'See src/subject.ts for details.\n');
      gitIn(root, 'add', 'docs/new-note.md');

      const result = docDrift(fakeDb(root), { doc: 'docs/new-note.md' });
      const finding = result.findings.find((f) => f.doc === 'docs/new-note.md');

      expect(finding).toBeDefined();
      expect(finding?.docLastChangedAt).toBeGreaterThan(0);
      expect(finding?.docLastChangedAtEstimated).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats an inline <!-- scip-query: snapshot --> marker the same as a configured glob', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-doc-drift-snapshot-marker-'));
    try {
      gitIn(root, 'init');
      commitIn(root, 'initial', {
        'docs/one-off-note.md': '<!-- scip-query: snapshot -->\nSnapshot of src/a.ts as of this date.\n',
        'src/a.ts': 'export const version = 1;\n',
      });
      commitIn(root, 'code moves on', { 'src/a.ts': 'export const version = 2;\n' });

      const result = docDrift(fakeDb(root), { limit: 10 });
      expect(result.findings.map((finding) => finding.doc)).not.toContain('docs/one-off-note.md');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
