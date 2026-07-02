import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRunRecord, collectEvidenceRows, parseArgs } from '../../scripts/performance-architecture-contract.mjs';

describe('performance architecture contract script', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('parses the validation command shape', () => {
    expect(
      parseArgs(['--repo', '.', '--command', 'health --json', '--warm-iterations', '1', '--no-clear']),
    ).toMatchObject({
      repo: '.',
      command: 'health --json',
      warmIterations: 1,
      noClear: true,
      cacheState: 'evidence-warm',
    });
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
      durationMs: 12,
      stdoutBytes: 12,
      stderrBytes: 0,
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
});
