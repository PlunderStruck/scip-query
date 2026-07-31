import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { diffGate } from '../../../src/queries/impact/diff-gate.js';
import type { DiffGateCheck } from '../../../src/queries/impact/diff-gate.js';
import { withDiffGateProgressObserver } from '../../../src/queries/internal/diff-gate-progress.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { createEvidenceSchema } from '../../fixtures/evidence-fixture.js';

const ARCHITECTURE_IDENTITY = 'architecture:forbidden-edge:storage:queries';
const NON_ARCHITECTURE_CHECKS: DiffGateCheck[] = [
  'echo',
  'incomplete-migration',
  'co-change-partner',
  'twin-partner',
  'coverage-contract',
  'doc-reference',
  'unused-params',
  'new-dead',
  'baseline',
];

function git(root: string, ...args: string[]): void {
  execFileSync('git', ['-C', root, ...args], {
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 't@t.t',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 't@t.t',
    },
  });
}

function withArchitectureDiff(
  run: (db: ScipDatabase, root: string) => void,
  changedSource = "import { query } from '../queries/api.js';\nexport const stored = query;\n",
): void {
  const root = mkdtempSync(join(tmpdir(), 'scip-query-architecture-ratchet-'));
  try {
    mkdirSync(join(root, 'src', 'storage'), { recursive: true });
    mkdirSync(join(root, 'src', 'queries'), { recursive: true });
    writeFileSync(join(root, 'src', 'storage', 'store.ts'), 'export const stored = 1;\n');
    writeFileSync(join(root, 'src', 'queries', 'api.ts'), 'export const query = 1;\n');
    git(root, 'init');
    git(root, 'add', '-A');
    git(root, 'commit', '-m', 'base', '--no-gpg-sign');

    writeFileSync(join(root, 'src', 'storage', 'store.ts'), changedSource);

    const dbPath = join(root, 'index.db');
    const sqliteDb = new Database(dbPath);
    createEvidenceSchema(sqliteDb);
    sqliteDb.exec(`
      INSERT INTO documents (id, language, relative_path) VALUES
        (1, 'typescript', 'src/storage/store.ts'),
        (2, 'typescript', 'src/queries/api.ts');
    `);
    sqliteDb.close();

    const db = new ScipDatabase({
      dbPath,
      indexPath: join(root, 'index.scip'),
      projectRoot: root,
      architecture: {
        boundaries: [
          { name: 'storage', paths: ['src/storage/**'] },
          { name: 'queries', paths: ['src/queries/**'] },
        ],
        allowedDependencies: {
          storage: [],
        },
      },
    });
    try {
      run(db, root);
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeBaseline(root: string, findings: string[]): void {
  writeFileSync(join(root, '.scipquery-baseline.json'), JSON.stringify({ version: 1, findings }, null, 2) + '\n');
}

describe('architecture diff-gate ratchet', () => {
  it('publishes detector start and completion around each executed check', () => {
    withArchitectureDiff((db, root) => {
      writeBaseline(root, []);
      const progress: string[] = [];

      withDiffGateProgressObserver(
        {
          onCheckStart: (check) => progress.push(`start:${check}`),
          onCheckComplete: (check) => progress.push(`complete:${check}`),
        },
        () =>
          diffGate(db, {
            base: 'HEAD',
            skip: NON_ARCHITECTURE_CHECKS,
          }),
      );

      expect(progress).toEqual(['start:architecture', 'complete:architecture']);
    });
  });

  it('blocks a new forbidden boundary pair with direct project-policy evidence', () => {
    withArchitectureDiff((db, root) => {
      writeBaseline(root, []);

      const result = diffGate(db, { base: 'HEAD', skip: NON_ARCHITECTURE_CHECKS });
      const finding = result.findings.find((candidate) => candidate.check === 'architecture');

      expect(result.checksRun).toContain('architecture');
      expect(finding).toMatchObject({
        check: 'architecture',
        actionTier: 'direct',
        evidence: 'baseline',
        sourceAnalyzer: 'architecture',
        rootCauseKey: 'forbidden-edge:storage:queries',
        file: 'src/storage/store.ts',
        relatedFiles: ['src/queries/api.ts', 'src/storage/store.ts'],
        message: expect.stringContaining(ARCHITECTURE_IDENTITY),
      });
      expect(finding?.why).toContain('Declared boundary rule rejects storage -> queries.');
    });
  });

  it('blocks a forbidden boundary pair expressed only through a re-export', () => {
    withArchitectureDiff((db, root) => {
      writeBaseline(root, []);

      const result = diffGate(db, { base: 'HEAD', skip: NON_ARCHITECTURE_CHECKS });
      const finding = result.findings.find((candidate) => candidate.check === 'architecture');

      expect(finding).toMatchObject({
        check: 'architecture',
        rootCauseKey: 'forbidden-edge:storage:queries',
        message: expect.stringContaining(ARCHITECTURE_IDENTITY),
      });
    }, "export { query } from '../queries/api.js';\n");
  });

  it('accepts recorded debt and does not duplicate architecture through the full baseline check', () => {
    withArchitectureDiff((db, root) => {
      writeBaseline(root, [ARCHITECTURE_IDENTITY]);

      const accepted = diffGate(db, { base: 'HEAD', skip: NON_ARCHITECTURE_CHECKS });
      expect(accepted.findings.filter((finding) => finding.check === 'architecture')).toEqual([]);

      writeBaseline(root, []);
      const withFullBaseline = diffGate(db, {
        base: 'HEAD',
        includeBaseline: true,
        skip: NON_ARCHITECTURE_CHECKS.filter((check) => check !== 'baseline'),
      });
      expect(
        withFullBaseline.findings.filter((finding) => finding.message.includes(ARCHITECTURE_IDENTITY)),
      ).toHaveLength(1);
      expect(withFullBaseline.findings.find((finding) => finding.message.includes(ARCHITECTURE_IDENTITY))?.check).toBe(
        'architecture',
      );
    });
  });

  it('skips with an enabling instruction when the shared baseline is absent', () => {
    withArchitectureDiff((db, root) => {
      const baselinePath = join(root, '.scipquery-baseline.json');
      try {
        unlinkSync(baselinePath);
      } catch {
        // The fixture intentionally starts without a baseline.
      }

      const result = diffGate(db, { base: 'HEAD', skip: NON_ARCHITECTURE_CHECKS });

      expect(result.checksRun).not.toContain('architecture');
      expect(result.skipped).toContainEqual({
        check: 'architecture',
        reason: 'no .scipquery-baseline.json — run health --write-baseline to enable',
      });
    });
  });
});
