import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import { classifyCoChangePartner, coChange, isCoChangeNoiseFile } from '../../../src/queries/cleanup/co-change.js';
import { diffGate, symbolPreexistenceChecker, type DiffGateCheck } from '../../../src/queries/impact/diff-gate.js';
import type { DiffImpactPlan } from '../../../src/queries/impact/diff-impact.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb } from '../../fixtures/evidence-fixture.js';

let commitClock = 1_700_100_000;
const tempRoots: string[] = [];
const openDbs: ScipDatabase[] = [];

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

function createFixture(): { db: ScipDatabase; repoRoot: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'scip-co-change-labels-'));
  tempRoots.push(repoRoot);
  gitIn(repoRoot, 'init');

  commitIn(repoRoot, 'initial', {
    'docs/api.md': 'api docs v0\n',
    'src/api.ts': 'export const apiVersion = 0;\n',
    'schema/user.schema.json': '{ "version": 0 }\n',
    'scripts/generate-user.ts': 'export const generatorVersion = 0;\n',
  });
  for (let version = 1; version <= 4; version += 1) {
    commitIn(repoRoot, `docs(api): api docs ${version} (#10${version})`, {
      'docs/api.md': `api docs v${version}\n`,
      'src/api.ts': `export const apiVersion = ${version};\n`,
    });
  }
  for (let version = 1; version <= 4; version += 1) {
    commitIn(repoRoot, `schema generator ${version}`, {
      'schema/user.schema.json': `{ "version": ${version} }\n`,
      'scripts/generate-user.ts': `export const generatorVersion = ${version};\n`,
    });
  }

  const dbPath = join(repoRoot, 'index.db');
  evidenceFixtureDb(dbPath)
    .document(1, 'markdown', 'docs/api.md')
    .document(2, 'typescript', 'src/api.ts')
    .document(3, 'json', 'schema/user.schema.json')
    .document(4, 'typescript', 'scripts/generate-user.ts')
    .write();

  const config: ScipQueryConfig = {
    dbPath,
    indexPath: join(repoRoot, 'index.scip'),
    projectRoot: repoRoot,
  };
  const db = new ScipDatabase(config);
  openDbs.push(db);
  return { db, repoRoot };
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('co-change partner labels', () => {
  it('excludes generated TypeScript incremental-build state from relationship candidates', () => {
    expect(isCoChangeNoiseFile('apps/web/tsconfig.tsbuildinfo')).toBe(true);
    expect(isCoChangeNoiseFile('packaging/aur/.SRCINFO')).toBe(true);
    expect(isCoChangeNoiseFile('uv.lock')).toBe(true);
    expect(isCoChangeNoiseFile('apps/web/src/tsconfig-state.ts')).toBe(false);
  });

  it('does not promote shared workspace roots and file extensions into same-feature evidence', () => {
    expect(
      classifyCoChangePartner(
        'frontend/ui/src/app/api/projects/[projectId]/messages/route.ts',
        'frontend/worker/src/ee/billing/usageMetering.ts',
      ).partnerClass,
    ).toBe('unknown');
    expect(
      classifyCoChangePartner(
        'examples/python/deepagents/requirements.txt',
        'examples/python/openai-tool-agent/requirements.txt',
      ).partnerClass,
    ).toBe('unknown');
    expect(
      classifyCoChangePartner('apps/api/src/db/schema/proposals.ts', 'apps/web/src/api/proposals.ts').partnerClass,
    ).toBe('same-feature');
  });

  it('classifies repeated contract-like pairs and suggests declared coupling', () => {
    const { db } = createFixture();

    const result = coChange(db, undefined, { minTogether: 4, minConfidence: 0.75, limit: 10 });

    const docCode = result.findings.find(
      (finding) => finding.fileA === 'docs/api.md' && finding.fileB === 'src/api.ts',
    );
    expect(docCode).toEqual(
      expect.objectContaining({
        partnerClass: 'doc-code',
        partnerClassReasons: expect.arrayContaining(['one side is documentation and the other is executable source']),
        recency: 'recent',
        recentTogether: expect.any(Number),
        commitScope: expect.any(String),
        subjectContext: {
          subjectLabels: ['docs'],
          issueRefs: ['#104', '#103', '#102', '#101'],
          sampleSubjects: [
            'docs(api): api docs 4 (#104)',
            'docs(api): api docs 3 (#103)',
            'docs(api): api docs 2 (#102)',
          ],
          externalIssueLabelStatus: 'unavailable',
        },
        declaredCouplingSuggestion: expect.objectContaining({
          files: ['docs/api.md', 'src/api.ts'],
        }),
      }),
    );

    const schemaScript = result.findings.find(
      (finding) => finding.fileA === 'schema/user.schema.json' && finding.fileB === 'scripts/generate-user.ts',
    );
    expect(schemaScript).toEqual(
      expect.objectContaining({
        partnerClass: 'schema-script',
        partnerClassReasons: expect.arrayContaining([
          'schema or contract file changes with a script or generated-code path',
        ]),
        recency: 'recent',
        recentTogether: expect.any(Number),
        commitScope: expect.any(String),
        declaredCouplingSuggestion: expect.objectContaining({
          files: ['schema/user.schema.json', 'scripts/generate-user.ts'],
        }),
      }),
    );
  });

  it('honors scanLimit by keeping only the highest-priority pairs (followup #6)', () => {
    const { db } = createFixture();

    const unbounded = coChange(db, undefined, { minTogether: 4, minConfidence: 0.75, limit: 10 });
    expect(unbounded.findings.length).toBeGreaterThan(1);

    const bounded = coChange(db, undefined, { minTogether: 4, minConfidence: 0.75, limit: 10, scanLimit: 1 });
    expect(bounded.findings).toHaveLength(1);
    expect(bounded.findings[0]?.together).toBe(Math.max(...unbounded.findings.map((finding) => finding.together)));
  });

  it('carries partner class and declared-coupling suggestions into diff-gate findings', () => {
    const { db, repoRoot } = createFixture();
    writeFileSync(join(repoRoot, 'src/api.ts'), 'export const apiVersion = 99;\n');

    const skippedChecks: DiffGateCheck[] = [
      'echo',
      'incomplete-migration',
      'doc-reference',
      'unused-params',
      'new-dead',
      'baseline',
    ];
    const result = diffGate(db, { base: 'HEAD', minTogether: 4, minConfidence: 0.75, skip: skippedChecks });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toEqual(
      expect.objectContaining({
        check: 'co-change-partner',
        actionTier: 'signal',
        sourceAnalyzer: 'co-change',
        file: 'src/api.ts',
        relatedFiles: ['docs/api.md'],
        partnerClass: 'doc-code',
        partnerClassReasons: expect.arrayContaining(['one side is documentation and the other is executable source']),
        recency: 'recent',
        recentTogether: expect.any(Number),
        commitScope: expect.any(String),
        subjectContext: expect.objectContaining({
          subjectLabels: ['docs'],
          externalIssueLabelStatus: 'unavailable',
        }),
        why: expect.arrayContaining([
          expect.stringContaining('History context:'),
          expect.stringContaining('Subject context:'),
        ]),
        declaredCouplingSuggestion: expect.objectContaining({
          files: ['docs/api.md', 'src/api.ts'],
        }),
        rootCauseKey: 'docs/api.md|src/api.ts',
        groupKey: 'co-change-partner:docs/api.md|src/api.ts',
      }),
    );
    expect(result.rootCauseGroups).toEqual([
      expect.objectContaining({
        groupKey: 'co-change-partner:docs/api.md|src/api.ts',
        sourceAnalyzer: 'co-change',
        rootCauseKey: 'docs/api.md|src/api.ts',
      }),
    ]);
  });

  it('does not report a co-change partner that is already changed in raw git diff paths', () => {
    const { db, repoRoot } = createFixture();
    writeFileSync(join(repoRoot, 'src/api.ts'), 'export const apiVersion = 99;\n');
    writeFileSync(join(repoRoot, 'docs/api.md'), 'api docs v99\n');

    const skippedChecks: DiffGateCheck[] = [
      'echo',
      'incomplete-migration',
      'doc-reference',
      'unused-params',
      'new-dead',
      'baseline',
    ];
    const result = diffGate(db, { base: 'HEAD', minTogether: 4, minConfidence: 0.75, skip: skippedChecks });

    expect(result.findings).toHaveLength(0);
  });

  it('treats symbols already present at the base revision as preexisting echo candidates', () => {
    const { repoRoot } = createFixture();
    writeFileSync(join(repoRoot, 'src/api.ts'), 'export const apiVersion = 99;\n');
    const plan: DiffImpactPlan = {
      changedFileLines: ['src/api.ts'],
      changedFiles: ['src/api.ts'],
      changedRanges: [],
      renamedFiles: [],
    };
    const checker = symbolPreexistenceChecker({ projectRoot: repoRoot, base: 'HEAD', diffPlan: plan });

    expect(
      checker({
        symbol: 'scip-typescript npm pkg 1.0.0 src/`api.ts`/apiVersion.',
        file: 'src/api.ts',
      }),
    ).toBe(true);
    expect(
      checker({
        symbol: 'scip-typescript npm pkg 1.0.0 src/`api.ts`/brandNewThing().',
        file: 'src/api.ts',
      }),
    ).toBe(false);
  });
});
