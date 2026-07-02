import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CoverageContractConfig, ScipQueryConfig } from '../../src/domain/types.js';
import { twinDrift } from '../../src/queries/cleanup/twin-drift.js';
import { blockingFindings, diffGate } from '../../src/queries/impact/diff-gate.js';
import { ScipDatabase } from '../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../fixtures/evidence-fixture.js';

// Plan 3 (docs/plans/2026-07-01-remediation-3-detection-primitives-and-lens-skills.md),
// step 20.1: the two review rounds are a labeled defect corpus. Each test
// below reproduces, in miniature, a historical instance the primitives in
// this plan (17.1 twin-drift, 17.2 twin-partner, 17.3 coverage contracts,
// 3.1 duplicate-bodies from Plan 1) were built to catch, so a future
// regression to any of these detectors is caught here first.

const tempRoots: string[] = [];
const openDbs: ScipDatabase[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function gitIn(root: string, ...args: string[]): void {
  execFileSync('git', ['-C', root, ...args], {
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 't@t.t',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 't@t.t',
      GIT_AUTHOR_DATE: '1700000000 +0000',
      GIT_COMMITTER_DATE: '1700000000 +0000',
    },
  });
}

function writeFile(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

describe('detects historical defects (round-1/round-2 review corpus)', () => {
  // Round-1 §1.4 / round-2 escapeRegex finding: `escapeRegex` (7 copies) and
  // `escapeRegExp` (3 copies) were near-name duplicates invisible to every
  // existing detector before twin-drift (17.1) — `similar` needs callee
  // overlap, `similar-signatures` needs matching type shapes, and neither
  // near-name pair nor drifted regex-escape bodies triggered either. This
  // reproduces that exact shape: two near-name (edit-distance <= 2,
  // length >= 8) functions in different files with divergent bodies.
  it('flags a near-name escapeRegex/escapeRegExp-shaped family as twin-drift', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'scip-regression-twin-drift-'));
    tempRoots.push(tempDir);
    const projectRoot = join(tempDir, 'project');
    writeFixtureFiles(projectRoot, {
      'src/a.ts': [
        'export function escapeRegex(value: string) {',
        "  return value.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');",
        '}',
      ],
      'src/b.ts': [
        'export function escapeRegExp(value: string) {',
        "  return value.replace(/[.*+?^${}()\\\\]/g, '\\\\-');",
        '}',
      ],
    });

    const dbPath = join(tempDir, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/a.ts')
      .document(2, 'typescript', 'src/b.ts')
      .symbol(1, 'scip-typescript npm fixture 1.0.0 src/`a.ts`/escapeRegex().', 'escapeRegex', 12)
      .symbol(2, 'scip-typescript npm fixture 1.0.0 src/`b.ts`/escapeRegExp().', 'escapeRegExp', 12)
      .definition(1, 1, 1, 0, 0, 2, 1)
      .definition(2, 2, 2, 0, 0, 2, 1)
      .write();

    const db = new ScipDatabase({ dbPath, projectRoot });
    openDbs.push(db);

    const groups = twinDrift(db);
    const family = groups.find((group) => group.members.some((member) => member.file === 'src/a.ts'));

    expect(family).toBeDefined();
    expect(family?.relationship).toBe('divergent');
    expect(family?.members.map((member) => member.file).sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  // Round-1/round-2 enumeration-rot finding: drift-policy's `allowed`
  // table (now `SRC_LAYER_DEPENDENCIES`) omitted `src/tla` for roughly a
  // day after that directory was added, producing a 73% false-positive
  // rate for every symbol under it — an enumeration hole no existing check
  // caught until coverage contracts (17.3). This reproduces the same
  // shape: a policy table's declared key set (object-literal-keys) versus
  // the real top-level dirs under `src` (ground truth), where the working
  // tree adds a new source directory the table was never updated for.
  it('flags a coverage-contract drift shaped like the drift-policy missing-src/tla incident', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'scip-regression-coverage-contract-'));
    tempRoots.push(repoRoot);
    gitIn(repoRoot, 'init');
    writeFile(
      join(repoRoot, 'src', 'drift-policy.ts'),
      'export const SRC_LAYER_DEPENDENCIES: Record<string, unknown> = {\n' +
        '  analysis: {},\n' +
        '  queries: {},\n' +
        '  runtime: {},\n' +
        '};\n',
    );
    writeFile(join(repoRoot, 'src', 'analysis', 'x.ts'), 'export const x = 1;\n');
    writeFile(join(repoRoot, 'src', 'queries', 'y.ts'), 'export const y = 1;\n');
    writeFile(join(repoRoot, 'src', 'runtime', 'z.ts'), 'export const z = 1;\n');
    gitIn(repoRoot, 'add', '-A');
    gitIn(repoRoot, 'commit', '-m', 'base: policy table matches src/*', '--no-gpg-sign');

    const dbPath = join(repoRoot, 'index.db');
    evidenceFixtureDb(dbPath).document(1, 'typescript', 'src/drift-policy.ts').write();

    const contract: CoverageContractConfig = {
      name: 'drift layer policy covers src dirs',
      file: 'src/drift-policy.ts',
      keys: { type: 'object-literal-keys', identifier: 'SRC_LAYER_DEPENDENCIES' },
      mustEqual: { type: 'top-level-dirs', path: 'src' },
      allowExtra: false,
    };
    const config: ScipQueryConfig = {
      dbPath,
      indexPath: join(repoRoot, 'index.scip'),
      projectRoot: repoRoot,
      coverageContracts: [contract],
    };
    const db = new ScipDatabase(config);
    openDbs.push(db);

    // Working tree adds a new source directory (mirrors `src/tla` landing)
    // without updating the policy table — uncommitted, so `base: 'HEAD'`
    // sees it as the diff.
    writeFile(join(repoRoot, 'src', 'tla', 'w.ts'), 'export const w = 1;\n');

    const result = diffGate(db, {
      base: 'HEAD',
      skip: ['echo', 'incomplete-migration', 'twin-partner', 'doc-reference', 'unused-params', 'new-dead'],
    });

    const contractFindings = result.findings.filter((finding) => finding.check === 'coverage-contract');
    expect(contractFindings).toHaveLength(1);
    expect(contractFindings[0]?.message).toContain('tla');
  });

  // Round-1/round-2 one-sided-fix finding: the citation classifier was
  // fixed in diff-gate but the equivalent logic in doc-drift was not — a
  // same-name twin left un-migrated by a one-sided change, invisible to
  // file-level co-change (which cannot see symbol-level twins). This is
  // the twin-partner check's (17.2) own acceptance scenario: a same-name
  // function edited in only one of its two files.
  it('flags a one-sided edit to a same-name twin as a twin-partner finding', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'scip-regression-twin-partner-'));
    tempRoots.push(repoRoot);
    gitIn(repoRoot, 'init');
    const bodyBefore = [
      'export function classify(value: string) {',
      '  return value.trim().toLowerCase();',
      '}',
      '',
    ].join('\n');
    writeFile(join(repoRoot, 'src', 'gate-classifier.ts'), bodyBefore);
    writeFile(join(repoRoot, 'src', 'doc-classifier.ts'), bodyBefore);
    gitIn(repoRoot, 'add', '-A');
    gitIn(repoRoot, 'commit', '-m', 'base: matching classify() twins', '--no-gpg-sign');

    const dbPath = join(repoRoot, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/gate-classifier.ts')
      .document(2, 'typescript', 'src/doc-classifier.ts')
      .symbol(1, 'scip-typescript npm fixture 1.0.0 src/`gate-classifier.ts`/classify().', 'classify', 12)
      .symbol(2, 'scip-typescript npm fixture 1.0.0 src/`doc-classifier.ts`/classify().', 'classify', 12)
      .definition(1, 1, 1, 0, 0, 2, 1)
      .definition(2, 2, 2, 0, 0, 2, 1)
      .write();

    const config: ScipQueryConfig = { dbPath, indexPath: join(repoRoot, 'index.scip'), projectRoot: repoRoot };
    const db = new ScipDatabase(config);
    openDbs.push(db);

    // Only the gate-side classifier gets the fix; the doc-side twin is left
    // behind — uncommitted, so `base: 'HEAD'` sees this as the diff.
    writeFile(
      join(repoRoot, 'src', 'gate-classifier.ts'),
      [
        'export function classify(value: string) {',
        "  return value.trim().toLowerCase().normalize('NFKC');",
        '}',
        '',
      ].join('\n'),
    );

    const result = diffGate(db, {
      base: 'HEAD',
      skip: ['echo', 'incomplete-migration', 'coverage-contract', 'doc-reference', 'unused-params', 'new-dead'],
    });

    const twinFindings = result.findings.filter((finding) => finding.check === 'twin-partner');
    expect(twinFindings).toHaveLength(1);
    expect(twinFindings[0]?.file).toBe('src/gate-classifier.ts');
    expect(twinFindings[0]?.relatedFiles).toEqual(['src/doc-classifier.ts']);
    // Advisory per 17.2's stress-test finding: never the sole cause of a
    // nonzero exit until 21.1 calibration says otherwise.
    expect(blockingFindings(result.findings)).toHaveLength(0);
  });

  // Round-1 §1.4 precision-decay finding: duplicate-bodies used to flag this
  // repo's own 11 intentional 1-LOC command-handler stubs (e.g.
  // `handleComplexity`, `handleChangeSurface` — each just forwards to a
  // shared implementation) as an echo group. Plan 3's own stress-test
  // section named this as a known calibration gap: 21.2 raised
  // `duplicate-bodies`' default `--min-loc` from 1 to 3, measured on the
  // isolated implementation body (not the surrounding signature/brace
  // lines), so single-statement forwarding stubs like these no longer
  // qualify as "duplicate" candidates by default.
  it('does NOT flag 1-LOC command-handler boilerplate as duplicate-bodies noise (post-21.2 calibration)', async () => {
    const { duplicateBodies } = await import('../../src/queries/cleanup/duplicate-bodies.js');
    const tempDir = mkdtempSync(join(tmpdir(), 'scip-regression-duplicate-bodies-'));
    tempRoots.push(tempDir);
    const projectRoot = join(tempDir, 'project');

    const handlerNames = Array.from({ length: 11 }, (_, index) => `handleCommand${index}`);
    const files: Record<string, string[]> = {};
    const builder = evidenceFixtureDb(join(tempDir, 'index.db'));
    handlerNames.forEach((name, index) => {
      const file = `src/handlers/${name}.ts`;
      files[file] = [`export function ${name}(opts: unknown) {`, '  return runShared(opts);', '}'];
      builder
        .document(index + 1, 'typescript', file)
        .symbol(index + 1, `scip-typescript npm fixture 1.0.0 ${file}\`/${name}().`, name, 12)
        .definition(index + 1, index + 1, index + 1, 0, 0, 2, 1);
    });
    writeFixtureFiles(projectRoot, files);
    builder.write();

    const db = new ScipDatabase({ dbPath: join(tempDir, 'index.db'), projectRoot });
    openDbs.push(db);

    // Intended post-21.2 behavior: 1-LOC single-statement forwarding
    // handlers are exempted as registration boilerplate, not reported.
    const groups = duplicateBodies(db, { maxLoc: 15 });
    expect(groups.filter((group) => group.functions.some((fn) => handlerNames.includes(fn.shortName)))).toHaveLength(0);
  });
});
