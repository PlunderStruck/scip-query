import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_SESSION_STATE_TTL_MS,
  MAX_AGENT_SESSION_PENDING_OUTPUTS,
  agentRestorationDeliveryEpoch,
  agentSessionStatePath,
  claimAgentSessionRestoration,
  pendingOutputFromTranscript,
  readAgentSessionState,
  readAgentTranscriptTail,
  renderAgentSessionRestoration,
  updateAgentSessionState,
  type AgentSessionPendingOutput,
} from '../../src/runtime/agent-session-state.js';
import type { PendingCliOutputSnapshot } from '../../src/runtime/output-pagination.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'scip-agent-session-'));
  roots.push(value);
  return value;
}

describe('agent session evidence continuity', () => {
  it('isolates state by session and project and expires it after the bounded lease', () => {
    const cacheDir = root();
    const projectRoot = '/repo/a';
    updateAgentSessionState({
      cacheDir,
      sessionId: 'session-a',
      projectRoot,
      nowMs: 1_000,
      latestStop: {
        attemptedAtMs: 1_000,
        outcome: 'findings',
        findingCount: 2,
        automaticSuppressionCount: 0,
        policyEscalationCount: 1,
      },
    });

    expect(readAgentSessionState(cacheDir, 'session-a', projectRoot, 1_001)?.latestStop?.findingCount).toBe(2);
    expect(readAgentSessionState(cacheDir, 'session-b', projectRoot, 1_001)).toBeUndefined();
    expect(readAgentSessionState(cacheDir, 'session-a', '/repo/b', 1_001)).toBeUndefined();
    expect(
      readAgentSessionState(cacheDir, 'session-a', projectRoot, 1_000 + AGENT_SESSION_STATE_TTL_MS),
    ).toBeUndefined();
    expect(agentSessionStatePath(cacheDir, 'session-a')).not.toBe(agentSessionStatePath(cacheDir, 'session-b'));
  });

  it('merges independently owned Stop and output fields and bounds pending snapshots', () => {
    const cacheDir = root();
    const pending = Array.from({ length: MAX_AGENT_SESSION_PENDING_OUTPUTS + 4 }, (_, index) =>
      pendingOutput(`snapshot-${index}`, index + 1, index + 1),
    );
    updateAgentSessionState({
      cacheDir,
      sessionId: 'session',
      projectRoot: '/repo',
      nowMs: 1_000,
      latestStop: {
        attemptedAtMs: 1_000,
        outcome: 'pass',
        findingCount: 0,
        automaticSuppressionCount: 0,
        policyEscalationCount: 0,
      },
    });
    const state = updateAgentSessionState({
      cacheDir,
      sessionId: 'session',
      projectRoot: '/repo',
      nowMs: 2_000,
      unfinishedOutput: pending,
    });

    expect(state.latestStop?.outcome).toBe('pass');
    expect(state.unfinishedOutput).toHaveLength(MAX_AGENT_SESSION_PENDING_OUTPUTS);
    expect(state.unfinishedOutput[0]?.createdAtMs).toBe(MAX_AGENT_SESSION_PENDING_OUTPUTS + 4);
  });

  it('discovers only live cursors from the same project and keeps the latest page per snapshot', () => {
    const firstCursor = 'a'.repeat(24);
    const secondCursor = 'b'.repeat(24);
    const otherCursor = 'c'.repeat(24);
    const snapshots = new Map<string, PendingCliOutputSnapshot>([
      [firstCursor, inspected('same', 1, '/repo')],
      [secondCursor, inspected('same', 2, '/repo/packages/a')],
      [otherCursor, inspected('other', 1, '/elsewhere')],
    ]);
    const transcript = [
      `command --output-cursor ${firstCursor}`,
      `command --output-cursor=${secondCursor}`,
      `command --output-cursor '${otherCursor}'`,
    ].join('\n');

    expect(pendingOutputFromTranscript(transcript, '/repo', (cursor) => snapshots.get(cursor))).toEqual([
      expect.objectContaining({ snapshotId: 'same', pageIndex: 2 }),
    ]);
  });

  it('reads only a bounded transcript tail and renders compact restoration obligations', () => {
    const dir = root();
    const transcriptPath = join(dir, 'transcript.jsonl');
    writeFileSync(transcriptPath, `${'old\n'.repeat(100)}LATEST-CURSOR\n`);

    expect(readAgentTranscriptTail(transcriptPath, 32)).toContain('LATEST-CURSOR');

    const state = updateAgentSessionState({
      cacheDir: dir,
      sessionId: 'session',
      projectRoot: '/repo',
      nowMs: 1_000,
      latestStop: {
        attemptedAtMs: 1_000,
        outcome: 'pass-with-suppressions',
        findingCount: 0,
        automaticSuppressionCount: 1,
        policyEscalationCount: 0,
        observation: {
          schemaVersion: 1,
          authorityKind: 'index-worktree',
          observedAt: '2026-07-28T00:00:00.000Z',
          projectIdentity: 'project-a',
          index: { generationIdentity: 'generation-a', source: 'immutable', alignment: 'leased' },
          worktree: { identity: 'worktree-a', clean: false },
        },
      },
      unfinishedOutput: [pendingOutput('snapshot', 1, 1)],
    });
    const rendered = renderAgentSessionRestoration(state);

    expect(rendered).toContain('Incomplete pages are not evidence');
    expect(rendered).toContain('Continue exactly');
    expect(rendered).toContain('pass-with-suppressions');
    expect(rendered).toContain('generation=generation-a');
  });

  it('atomically suppresses only an equal restoration meaning for the same hook event', () => {
    const cacheDir = root();
    const base = {
      cacheDir,
      sessionId: 'session',
      projectRoot: '/repo',
      projectionCursor: 'a'.repeat(64),
      deliveryEpoch: agentRestorationDeliveryEpoch('transcript-one'),
      nowMs: 1_000,
    };

    expect(claimAgentSessionRestoration(base).claimed).toBe(true);
    expect(claimAgentSessionRestoration({ ...base, nowMs: 1_001 }).claimed).toBe(false);
    expect(
      claimAgentSessionRestoration({
        ...base,
        projectionCursor: 'b'.repeat(64),
        nowMs: 1_002,
      }).claimed,
    ).toBe(true);
    expect(
      claimAgentSessionRestoration({
        ...base,
        projectionCursor: 'b'.repeat(64),
        deliveryEpoch: agentRestorationDeliveryEpoch('transcript-two'),
        nowMs: 1_003,
      }).claimed,
    ).toBe(true);
  });

  it('redelivers when no stable hook-event epoch can be observed', () => {
    const cacheDir = root();
    const input = {
      cacheDir,
      sessionId: 'session',
      projectRoot: '/repo',
      projectionCursor: 'a'.repeat(64),
      nowMs: 1_000,
    };

    expect(claimAgentSessionRestoration(input).claimed).toBe(true);
    expect(claimAgentSessionRestoration({ ...input, nowMs: 1_001 }).claimed).toBe(true);
  });
});

function pendingOutput(snapshotId: string, pageIndex: number, createdAtMs: number): AgentSessionPendingOutput {
  return {
    snapshotId,
    pageIndex,
    command: 'refs',
    continuationCommand: `scip-query refs Symbol --output-cursor ${'a'.repeat(24)}`,
    remainingCharacters: 100,
    totalCharacters: 200,
    outputHash: 'a'.repeat(64),
    createdAtMs,
  };
}

function inspected(snapshotId: string, pageIndex: number, cwd: string): PendingCliOutputSnapshot {
  return {
    ...pendingOutput(snapshotId, pageIndex, pageIndex),
    cwd,
  };
}
