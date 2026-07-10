import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildRetroGatePlan,
  buildRunRecord,
  collectEvidenceRows,
  main,
  parseArgs,
} from '../../scripts/performance-architecture-contract.mjs';

describe('performance architecture contract script', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('parses the validation command shape', () => {
    expect(
      parseArgs([
        '--repo',
        '.',
        '--command',
        'health --json',
        '--warm-iterations',
        '1',
        '--no-clear',
        '--label',
        'baseline',
      ]),
    ).toMatchObject({
      repo: '.',
      command: 'health --json',
      warmIterations: 1,
      noClear: true,
      cacheState: 'evidence-warm',
      label: 'baseline',
    });
  });

  it('preserves an explicit cache state when --no-clear is also used', () => {
    expect(parseArgs(['--cache-state', 'warm-index', '--no-clear'])).toMatchObject({
      noClear: true,
      cacheState: 'warm-index',
    });
  });

  it('parses retro-gate replay options', () => {
    expect(
      parseArgs([
        '--cache-state',
        'retro-gate',
        '--command',
        'diff-gate --json',
        '--retro-count',
        '5',
        '--retro-dry-run',
      ]),
    ).toMatchObject({
      cacheState: 'retro-gate',
      command: 'diff-gate --json',
      retroCount: 5,
      retroDryRun: true,
    });
  });

  it('builds retro-gate replay worktrees with parent bases', () => {
    expect(
      buildRetroGatePlan({
        repoPath: '/repo',
        commits: ['abc1234567890', 'def1234567890'],
        command: ['diff-gate', '--json'],
        worktreeRoot: '/tmp/retro',
      }),
    ).toEqual([
      {
        repoPath: '/repo',
        commit: 'abc1234567890',
        parent: 'abc1234567890^',
        worktreePath: '/tmp/retro/retro-abc123456789',
        command: ['diff-gate', '--json', '--base', 'abc1234567890^'],
      },
      {
        repoPath: '/repo',
        commit: 'def1234567890',
        parent: 'def1234567890^',
        worktreePath: '/tmp/retro/retro-def123456789',
        command: ['diff-gate', '--json', '--base', 'def1234567890^'],
      },
    ]);
  });

  it('constructs benchmark records with output hash and byte counts', () => {
    const record = buildRunRecord({
      repoPath: '/repo',
      gitHead: 'abc',
      dirty: false,
      command: ['health', '--json'],
      cacheState: 'evidence-warm',
      runId: 'run',
      iteration: 1,
      dbPath: '/missing/index.db',
      evidencePath: '/missing/evidence.db',
      beforeIndexBytes: 100,
      beforeEvidenceBytes: 20,
      profilePath: '/tmp/profile.jsonl',
      evidenceRows: { file_evidence: {}, project_evidence: {} },
      nowIso: '2026-07-02T00:00:00.000Z',
      result: {
        durationMs: 12,
        exitCode: 0,
        signal: null,
        stdout: Buffer.from('{"ok":true}\n'),
        stderr: Buffer.from(''),
      },
    });

    expect(record).toMatchObject({
      command: 'scip-query health --json',
      label: undefined,
      durationMs: 12,
      stdoutBytes: 12,
      stderrBytes: 0,
      beforeIndexBytes: 100,
      beforeEvidenceBytes: 20,
      indexBytes: 0,
      evidenceBytes: 0,
    });
    expect(record.stdoutSha256).toHaveLength(64);
  });

  it('returns stable empty evidence row buckets when evidence.db is absent', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-plan6-contract-'));

    expect(collectEvidenceRows(join(tempDir, 'evidence.db'))).toEqual({
      file_evidence: {},
      project_evidence: {},
      semantic_callees: { total: 0 },
      semantic_references: { total: 0 },
      finding_outcome_ledger: { total: 0 },
    });
  });

  it('resolves explicit profile output before spawning target repo commands', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-plan6-contract-'));
    const repoPath = join(tempDir, 'target-repo');
    const runHistoryPath = join(tempDir, 'runs.jsonl');
    const profileOut = 'relative-profiles/run.profile.jsonl';
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      main(['--repo', repoPath, '--command', 'health --json', '--out', runHistoryPath, '--profile-out', profileOut], {
        appendFileSync: () => undefined,
        existsSync: () => false,
        mkdirSync: () => undefined,
        mkdtempSync,
        rmSync,
        spawnSync: (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
          calls.push({ command, args, env: options?.env });
          if (command === 'git') return { status: 0, stdout: '', stderr: '', signal: null };
          if (args.includes('status')) {
            return {
              status: 0,
              stdout: Buffer.from(JSON.stringify({ result: { dbPath: join(tempDir!, 'cache', 'index.db') } })),
              stderr: Buffer.alloc(0),
              signal: null,
            };
          }
          return { status: 0, stdout: Buffer.from('{}\n'), stderr: Buffer.alloc(0), signal: null };
        },
      });
    } finally {
      stdoutWrite.mockRestore();
    }

    const profiledCall = calls.find((call) => call.args.includes('health'));
    expect(profiledCall?.env?.SCIP_QUERY_PROFILE_OUT).toBe(resolve(profileOut));
  });

  it('clears health report cache for evidence-cold measurements', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-plan6-contract-'));
    const cacheDir = join(tempDir, 'cache');
    const healthReportPath = join(cacheDir, 'health-report-cache.json');
    const removedPaths: string[] = [];
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      main(['--repo', join(tempDir, 'target-repo'), '--command', 'health --json'], {
        appendFileSync: () => undefined,
        existsSync: (path: string) => path === healthReportPath,
        mkdirSync: () => undefined,
        mkdtempSync,
        rmSync: (path: string) => {
          removedPaths.push(path);
        },
        spawnSync: (command: string, args: string[]) => {
          if (command === 'git') return { status: 0, stdout: '', stderr: '', signal: null };
          if (args.includes('status')) {
            return {
              status: 0,
              stdout: Buffer.from(JSON.stringify({ result: { dbPath: join(cacheDir, 'index.db') } })),
              stderr: Buffer.alloc(0),
              signal: null,
            };
          }
          return { status: 0, stdout: Buffer.from('{}\n'), stderr: Buffer.alloc(0), signal: null };
        },
      });
    } finally {
      stdoutWrite.mockRestore();
    }

    expect(removedPaths).toContain(healthReportPath);
  });
});
