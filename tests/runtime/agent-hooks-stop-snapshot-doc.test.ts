import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runStopHookDiffGate } from '../../src/runtime/agent-hooks.js';
import { loadProjectConfig } from '../../src/runtime/config.js';
import { runtimeFingerprint } from '../../src/runtime/index-freshness.js';
import { diffGate } from '../../src/queries/impact/diff-gate.js';
import { computeEffectiveness } from '../../src/queries/health/effectiveness.js';
import { readLedgerRecords } from '../../src/queries/health/finding-outcome-ledger.js';
import { ScipDatabase } from '../../src/storage/db.js';
import { readOutcomeEvents } from '../../src/storage/outcome-events.js';
import { resolveGitWorktreeContext } from '../../src/platform/git-worktree.js';
import { evidenceFixtureDb } from '../fixtures/evidence-fixture.js';

// Regression coverage for the Stop-hook path: `resolveHookWorkspace` +
// `withWorkspaceDb` (src/runtime/agent-hooks.ts) load .scipquery.json and
// build a ScipQueryConfig for diff-gate independently of the CLI's
// openDb() (src/runtime/cli-context.ts). `withWorkspaceDb` omitted the
// `docs` field, so `isSnapshotDoc` (src/queries/cleanup/diff-gate-doc-policy.ts)
// saw an empty `docs.snapshotPaths` list in the live Stop hook even though
// .scipquery.json configures it — every snapshot-doc citation (docs/benchmarks/**,
// docs/validation/**, docs/reviews/**, docs/plans/**) surfaced as a live
// doc-reference finding, blocking or advisory, instead of being exempted.
//
// This exercises the exact hook entry point (`runStopHookDiffGate`, the
// testable core of `handleAgentHookStop`) rather than calling `diffGate`
// directly, because `diffGate` itself was never broken — only the config
// wiring feeding it from the Stop hook was.

const tempRoots: string[] = [];

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

function buildRepo(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'scip-hook-stop-snapshot-doc-'));
  tempRoots.push(repoRoot);
  gitIn(repoRoot, 'init');

  writeFile(join(repoRoot, 'src', 'a.ts'), 'export const version = 1;\n');
  writeFile(
    join(repoRoot, 'docs', 'benchmarks', '2026-06-28-ledger.md'),
    'This benchmark ledger cites src/a.ts as of 2026-06-28.\n',
  );
  writeFile(join(repoRoot, 'docs', 'guide.md'), 'See src/a.ts for the entry point.\n');
  writeFile(
    join(repoRoot, '.scipquery.json'),
    JSON.stringify({
      dbPath: '.scip-query',
      watch: { enabled: false, autoRefresh: false },
      docs: { snapshotPaths: ['docs/benchmarks/**', 'docs/validation/**', 'docs/reviews/**', 'docs/plans/**'] },
    }),
  );
  writeFile(join(repoRoot, '.gitignore'), '.scip-query/\n');

  const dbDir = join(repoRoot, '.scip-query');
  mkdirSync(dbDir, { recursive: true });
  evidenceFixtureDb(join(dbDir, 'index.db')).document(1, 'typescript', 'src/a.ts').write();
  markFixtureIndexFresh(repoRoot);

  gitIn(repoRoot, 'add', '-A');
  gitIn(repoRoot, 'commit', '-m', 'base', '--no-gpg-sign');

  // Uncommitted edit: exactly what the live Stop hook diffs against HEAD.
  writeFile(join(repoRoot, 'src', 'a.ts'), 'export const version = 2;\n');

  return repoRoot;
}

function markFixtureIndexFresh(repoRoot: string): void {
  const config = loadProjectConfig(repoRoot);
  writeFile(
    join(repoRoot, '.scip-query', 'meta.json'),
    `${JSON.stringify({
      version: 3,
      status: 'complete',
      updatedAt: new Date().toISOString(),
      fingerprint: runtimeFingerprint(repoRoot, ['typescript'], config),
      indexedLanguages: ['typescript'],
    })}\n`,
  );
}

function hookInputFor(cwd: string, stopHookActive = false): string {
  return JSON.stringify({ hook_event_name: 'Stop', cwd, stop_hook_active: stopHookActive });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Stop hook doc-reference snapshot-doc exemption', () => {
  it('refuses to run against the stale fixture instead of returning a false clean result', async () => {
    const repoRoot = buildRepo();

    await expect(runStopHookDiffGate(hookInputFor(repoRoot))).rejects.toThrow(/evidence is stale/i);
  });

  it('produces zero doc-reference findings (blocking or advisory) for a snapshot-pathed doc', async () => {
    const repoRoot = buildRepo();
    markFixtureIndexFresh(repoRoot);

    const result = await runStopHookDiffGate(hookInputFor(repoRoot));

    expect(result).toBeDefined();
    const docFindings = (result?.findings ?? []).filter((finding) => finding.check === 'doc-reference');
    const snapshotDocFindings = docFindings.filter(
      (finding) => finding.file === 'docs/benchmarks/2026-06-28-ledger.md',
    );
    expect(snapshotDocFindings).toHaveLength(0);
  });

  it('control: still flags a non-snapshot doc citing the same changed file', async () => {
    const repoRoot = buildRepo();
    markFixtureIndexFresh(repoRoot);

    const result = await runStopHookDiffGate(hookInputFor(repoRoot));

    const docFindings = (result?.findings ?? []).filter((finding) => finding.check === 'doc-reference');
    const guideFindings = docFindings.filter((finding) => finding.file === 'docs/guide.md');
    expect(guideFindings).toHaveLength(1);
  });

  it('re-evaluates a continued Stop after the agent fixes a reported finding', async () => {
    const repoRoot = buildRepo();
    markFixtureIndexFresh(repoRoot);

    const first = await runStopHookDiffGate(hookInputFor(repoRoot));
    const guideFinding = first?.findings.find(
      (finding) => finding.check === 'doc-reference' && finding.file === 'docs/guide.md',
    );
    expect(guideFinding).toBeDefined();

    writeFile(join(repoRoot, 'docs', 'guide.md'), 'General project guidance.\n');
    markFixtureIndexFresh(repoRoot);
    const second = await runStopHookDiffGate(hookInputFor(repoRoot, true));
    expect(second?.findings.some((finding) => finding.id === guideFinding?.id)).toBe(false);

    const events = readOutcomeEvents(repoRoot).events.filter((event) => event.findingId === guideFinding?.id);
    expect(events.map((event) => event.event)).toEqual(['caught', 'resolved']);
    expect(computeEffectiveness(events).checks[0]).toMatchObject({ caught: 1, fixed: 1, open: 0 });
  });

  it('keeps a committed finding open, then verifies the later committed repair against its original base', async () => {
    const repoRoot = buildRepo();
    markFixtureIndexFresh(repoRoot);

    const first = await runStopHookDiffGate(hookInputFor(repoRoot));
    const guideFinding = first?.findings.find(
      (finding) => finding.check === 'doc-reference' && finding.file === 'docs/guide.md',
    );
    expect(guideFinding).toBeDefined();

    gitIn(repoRoot, 'add', '-A');
    gitIn(repoRoot, 'commit', '-m', 'commit defect', '--no-gpg-sign');
    expect(resolveGitWorktreeContext(repoRoot)?.clean).toBe(true);
    markFixtureIndexFresh(repoRoot);
    const committedDefect = await runStopHookDiffGate(hookInputFor(repoRoot));
    expect(committedDefect?.findings).toEqual([]);
    let events = readOutcomeEvents(repoRoot).events.filter((event) => event.findingId === guideFinding?.id);
    expect(events.map((event) => event.event)).toEqual(['caught']);
    expect(computeEffectiveness(events).checks[0]).toMatchObject({ fixed: 0, open: 1 });

    writeFile(join(repoRoot, 'docs', 'guide.md'), 'General project guidance.\n');
    gitIn(repoRoot, 'add', '-A');
    gitIn(repoRoot, 'commit', '-m', 'repair citation', '--no-gpg-sign');
    expect(resolveGitWorktreeContext(repoRoot)?.clean).toBe(true);
    const replayDb = new ScipDatabase({
      projectRoot: repoRoot,
      dbPath: join(repoRoot, '.scip-query', 'index.db'),
      indexPath: join(repoRoot, '.scip-query', 'index.scip'),
      docs: { snapshotPaths: ['docs/benchmarks/**', 'docs/validation/**', 'docs/reviews/**', 'docs/plans/**'] },
    });
    try {
      const replay = diffGate(replayDb, { base: events[0]!.comparisonBaseCommit, minTogether: 6, skip: [] });
      expect(replay.checksRun).toContain('doc-reference');
      expect(replay.findings.some((finding) => finding.id === guideFinding?.id)).toBe(false);
      expect(readLedgerRecords(replayDb).find((record) => record.findingId === guideFinding?.id)?.outcome).toBe(
        'still-open',
      );
    } finally {
      replayDb.close();
    }
    markFixtureIndexFresh(repoRoot);
    const committedRepair = await runStopHookDiffGate(hookInputFor(repoRoot));
    expect(committedRepair?.findings).toEqual([]);

    const afterDb = new ScipDatabase({
      projectRoot: repoRoot,
      dbPath: join(repoRoot, '.scip-query', 'index.db'),
      indexPath: join(repoRoot, '.scip-query', 'index.scip'),
    });
    try {
      expect(readLedgerRecords(afterDb).find((record) => record.findingId === guideFinding?.id)?.outcome).toBe(
        'resolved',
      );
    } finally {
      afterDb.close();
    }

    events = readOutcomeEvents(repoRoot).events.filter((event) => event.findingId === guideFinding?.id);
    expect(events.map((event) => event.event)).toEqual(['caught', 'resolved']);
    expect(events.at(-1)).toEqual(expect.objectContaining({ verifiedAgainstCommit: events[0]?.comparisonBaseCommit }));
    expect(computeEffectiveness(events).checks[0]).toMatchObject({ fixed: 1, unverified: 0, open: 0 });
  });
});
