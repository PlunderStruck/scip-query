import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runStopHookDiffGate } from '../../src/runtime/agent-hooks.js';
import { computeEffectiveness } from '../../src/queries/health/effectiveness.js';
import { readOutcomeEvents } from '../../src/storage/outcome-events.js';
import { evidenceFixtureDb } from '../fixtures/evidence-fixture.js';

// Regression coverage for the Stop-hook path: `resolveHookWorkspace` +
// `withWorkspaceDb` (src/runtime/agent-hooks.ts) load .scipquery.json and
// build a ScipQueryConfig for diff-gate independently of the CLI's
// openDb() (src/runtime/cli-context.ts). `withWorkspaceDb` omitted the
// `docs` field, so `isSnapshotDoc` (src/queries/impact/diff-gate-doc-policy.ts)
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
      docs: { snapshotPaths: ['docs/benchmarks/**', 'docs/validation/**', 'docs/reviews/**', 'docs/plans/**'] },
    }),
  );

  const dbDir = join(repoRoot, '.scip-query');
  mkdirSync(dbDir, { recursive: true });
  evidenceFixtureDb(join(dbDir, 'index.db')).document(1, 'typescript', 'src/a.ts').write();

  gitIn(repoRoot, 'add', '-A');
  gitIn(repoRoot, 'commit', '-m', 'base', '--no-gpg-sign');

  // Uncommitted edit: exactly what the live Stop hook diffs against HEAD.
  writeFile(join(repoRoot, 'src', 'a.ts'), 'export const version = 2;\n');

  return repoRoot;
}

function hookInputFor(cwd: string): string {
  return JSON.stringify({ hook_event_name: 'Stop', cwd });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Stop hook doc-reference snapshot-doc exemption', () => {
  it('produces zero doc-reference findings (blocking or advisory) for a snapshot-pathed doc', () => {
    const repoRoot = buildRepo();

    const result = runStopHookDiffGate(hookInputFor(repoRoot));

    expect(result).toBeDefined();
    const docFindings = (result?.findings ?? []).filter((finding) => finding.check === 'doc-reference');
    const snapshotDocFindings = docFindings.filter(
      (finding) => finding.file === 'docs/benchmarks/2026-06-28-ledger.md',
    );
    expect(snapshotDocFindings).toHaveLength(0);
  });

  it('control: still flags a non-snapshot doc citing the same changed file', () => {
    const repoRoot = buildRepo();

    const result = runStopHookDiffGate(hookInputFor(repoRoot));

    const docFindings = (result?.findings ?? []).filter((finding) => finding.check === 'doc-reference');
    const guideFindings = docFindings.filter((finding) => finding.file === 'docs/guide.md');
    expect(guideFindings).toHaveLength(1);
  });

  it('records a normal installed-hook finding as fixed after the cited code link is removed', () => {
    const repoRoot = buildRepo();

    const first = runStopHookDiffGate(hookInputFor(repoRoot));
    const guideFinding = first?.findings.find(
      (finding) => finding.check === 'doc-reference' && finding.file === 'docs/guide.md',
    );
    expect(guideFinding).toBeDefined();

    writeFile(join(repoRoot, 'docs', 'guide.md'), 'General project guidance.\n');
    const second = runStopHookDiffGate(hookInputFor(repoRoot));
    expect(second?.findings.some((finding) => finding.id === guideFinding?.id)).toBe(false);

    const events = readOutcomeEvents(repoRoot).filter((event) => event.findingId === guideFinding?.id);
    expect(events.map((event) => event.event)).toEqual(['caught', 'resolved']);
    expect(computeEffectiveness(events).checks[0]).toMatchObject({ caught: 1, fixed: 1, open: 0 });
  });
});
