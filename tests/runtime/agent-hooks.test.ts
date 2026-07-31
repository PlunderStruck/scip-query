import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DiffGateResult } from '../../src/queries/impact/diff-gate.js';
import { summarizeRecordCompatibility } from '../../src/domain/record-compatibility.js';
import { resolveIndexStoragePaths } from '../../src/platform/cache-layout.js';
import { updateAgentSessionState } from '../../src/runtime/agent-session-state.js';
import { createObligationAdmissionFile } from '../../src/storage/autonomous-work-obligations.js';
import { createGoalRecordFile, createIntendedChangeRecordFile } from '../../src/storage/autonomous-work-state.js';
import {
  evaluatePreToolUse,
  renderAgentHookContext,
  refreshIndexForHookIfNeeded,
  renderStopHookExecutionFailure,
  renderStopHookOutput,
  renderUserPromptContext,
  resolveStopHookMode,
  routesForPrompt,
} from '../../src/runtime/agent-hooks.js';

describe('agent hook context', () => {
  it('wakes an enabled idle service and requests refresh when the index is stale', async () => {
    const requestRefresh = vi.fn();
    const note = await refreshIndexForHookIfNeeded(
      hookWorkspace({ watch: { enabled: true, autoRefresh: true } }),
      'UserPromptSubmit',
      {
        ensureService: vi.fn(() => ({ kind: 'reused', state: watchState('idle') })),
        freshness: vi.fn(() => ({ state: 'stale' })),
        requestRefresh,
        startOneShot: vi.fn(),
      },
    );

    expect(note).toContain('woke the watch service and requested refresh');
    expect(requestRefresh).toHaveBeenCalledWith(
      expect.stringContaining('watch-activity.json'),
      expect.stringContaining('stale index'),
    );
  });

  it('keeps the one-shot SessionStart fallback when live watching is disabled', async () => {
    const startOneShot = vi.fn();
    const note = await refreshIndexForHookIfNeeded(
      hookWorkspace({ watch: { enabled: false, autoRefresh: true } }),
      'SessionStart',
      {
        ensureService: vi.fn(),
        freshness: vi.fn(() => ({ state: 'missing' })),
        requestRefresh: vi.fn(),
        startOneShot,
      },
    );

    expect(note).toContain('started background refresh');
    expect(startOneShot).toHaveBeenCalledWith('/repo');
  });

  it('exits quietly outside a git-backed scip-query workspace', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'scip-query-hook-'));

    const output = await renderAgentHookContext(
      JSON.stringify({
        hook_event_name: 'SessionStart',
        cwd,
      }),
    );

    expect(output).toBeUndefined();
  });

  it('restores only the matching session receipt after compaction', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'scip-query-hook-session-'));
    try {
      execFileSync('git', ['init', '--quiet'], { cwd });
      const projectRoot = realpathSync(cwd);
      const paths = resolveIndexStoragePaths(projectRoot, {});
      updateAgentSessionState({
        cacheDir: paths.cacheDir,
        sessionId: 'session-a',
        projectRoot,
        latestStop: {
          attemptedAtMs: Date.now(),
          outcome: 'findings',
          findingCount: 1,
          automaticSuppressionCount: 0,
          policyEscalationCount: 0,
        },
      });

      const restored = await renderAgentHookContext(
        JSON.stringify({ hook_event_name: 'PostCompact', cwd, session_id: 'session-a' }),
      );
      expect(restored).toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'PostCompact',
          additionalContext: expect.stringContaining('Latest scip-query Stop attempt: findings'),
        },
      });
      await expect(
        renderAgentHookContext(JSON.stringify({ hook_event_name: 'PostCompact', cwd, session_id: 'session-b' })),
      ).resolves.toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('restores committed autonomous work on process start and deduplicates an unchanged compaction event', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'scip-query-hook-restoration-'));
    try {
      execFileSync('git', ['init', '--quiet'], { cwd });
      writeFileSync(join(cwd, '.scipquery.json'), JSON.stringify({ watch: { autoRefresh: false } }));
      const goal = createGoalRecordFile(
        cwd,
        '5ea57d1a-936c-4c91-b58f-5d61e45173a5',
        {
          feature: 'An agent resumes autonomous work after process death',
          invariants: ['Every live obligation is restored'],
          acceptanceScenarios: [
            {
              name: 'Fresh process',
              given: ['committed work records exist'],
              when: ['a session starts'],
              then: ['the current goal and obligations are injected'],
            },
          ],
          authorization: {
            kind: 'repository-delegation',
            principal: 'repository-owner',
            source: 'test',
          },
        },
        { toolVersion: '0.20.0' },
      ).record;
      const change = createIntendedChangeRecordFile(
        cwd,
        goal.collaborationDomainId,
        {
          goalId: goal.goalId,
          idempotencyKey: 'hook-restoration',
          title: 'Restore committed state',
          intendedOutcome: 'A fresh process resumes the authorized change',
        },
        { toolVersion: '0.20.0' },
      ).record;
      const obligation = createObligationAdmissionFile(
        cwd,
        goal.collaborationDomainId,
        {
          changeId: change.changeId,
          idempotencyKey: 'live',
          category: 'verification',
          title: 'Verify hook restoration',
          requiredCondition: 'Session start and compaction recover this obligation',
          source: { kind: 'agent-discovery', referent: 'agent hook test' },
          basisAttemptIds: [],
          evidenceReceipts: [],
        },
        { toolVersion: '0.20.0' },
      ).record;
      const transcriptPath = join(cwd, 'transcript.jsonl');
      writeFileSync(transcriptPath, '{"event":"compacted"}\n');

      const started = await renderAgentHookContext(
        JSON.stringify({ hook_event_name: 'SessionStart', cwd, session_id: 'new-session' }),
      );
      expect(started).toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: expect.stringContaining(`LIVE ${obligation.obligationId}`),
        },
      });
      await expect(
        renderAgentHookContext(
          JSON.stringify({
            hook_event_name: 'UserPromptSubmit',
            cwd,
            session_id: 'new-session',
            prompt: 'continue',
          }),
        ),
      ).resolves.toBeUndefined();

      const changedObligation = createObligationAdmissionFile(
        cwd,
        goal.collaborationDomainId,
        {
          changeId: change.changeId,
          idempotencyKey: 'new-live-state',
          category: 'verification',
          title: 'Deliver changed state once',
          requiredCondition: 'The next prompt receives this newly live obligation exactly once',
          source: { kind: 'agent-discovery', referent: 'changed-state hook test' },
          basisAttemptIds: [],
          evidenceReceipts: [],
        },
        { toolVersion: '0.20.0' },
      ).record;
      const changed = await renderAgentHookContext(
        JSON.stringify({
          hook_event_name: 'UserPromptSubmit',
          cwd,
          session_id: 'new-session',
          prompt: 'continue',
        }),
      );
      expect(changed).toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: expect.stringContaining(`LIVE ${changedObligation.obligationId}`),
        },
      });
      await expect(
        renderAgentHookContext(
          JSON.stringify({
            hook_event_name: 'UserPromptSubmit',
            cwd,
            session_id: 'new-session',
            prompt: 'continue',
          }),
        ),
      ).resolves.toBeUndefined();

      const compacted = await renderAgentHookContext(
        JSON.stringify({
          hook_event_name: 'PostCompact',
          cwd,
          session_id: 'new-session',
          transcript_path: transcriptPath,
        }),
      );
      expect(compacted).toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'PostCompact',
          additionalContext: expect.stringContaining(`Goal ${goal.goalId}`),
        },
      });
      await expect(
        renderAgentHookContext(
          JSON.stringify({
            hook_event_name: 'PostCompact',
            cwd,
            session_id: 'new-session',
            transcript_path: transcriptPath,
          }),
        ),
      ).resolves.toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('routes user prompts toward one prioritized scip skill', () => {
    const context = renderUserPromptContext('Please debug this failing setup and then draw a diagram of the flow');

    expect(context).toContain('scip-setup');
    expect(context).not.toContain('scip-diagnose');
    expect(context).not.toContain('scip-explore');
  });

  it('skips drive-by single-keyword prompts unless a skill is explicit', () => {
    expect(renderUserPromptContext('Please review this')).toBe('');
    expect(routesForPrompt('Please use scip-diagnose on this')).toMatchObject({ id: 'debug' });
  });

  it('can disable prompt routing through config or env', () => {
    expect(
      renderUserPromptContext('Raise the health score as high as reasonably possible', { hooks: { router: 'off' } }),
    ).toBe('');
    expect(
      renderUserPromptContext(
        'Raise the health score as high as reasonably possible',
        {},
        { SCIP_QUERY_ROUTER: 'off' },
      ),
    ).toBe('');
  });

  it('routes health score prompts toward autonomous improvement when enough evidence is present', () => {
    const context = renderUserPromptContext('Raise the health score as high as reasonably possible');

    expect(context).toContain('scip-audit');
    expect(context).toContain('scip-improve');
  });

  it('blocks blind truncation for every pageable command', () => {
    expect(
      evaluatePreToolUse(
        { tool_name: 'Bash', tool_input: { command: 'scip-query refs login --json | head -50' } },
        true,
      ),
    ).toMatchObject({ kind: 'deny', reason: expect.stringContaining('--output-cursor') });
    expect(
      evaluatePreToolUse(
        { tool_name: 'Bash', tool_input: { command: "scip-query diff-gate --json | sed -n '1,80p'" } },
        true,
      ),
    ).toMatchObject({ kind: 'deny', reason: expect.stringContaining('exact emitted paging command') });
    expect(
      evaluatePreToolUse(
        {
          tool_name: 'Bash',
          tool_input: { command: '/repo/node_modules/.bin/scip-query system auth --json | tail -20' },
        },
        true,
      ),
    ).toMatchObject({ kind: 'deny' });
    expect(
      evaluatePreToolUse(
        { tool_name: 'Bash', tool_input: { command: 'node dist/cli.js refs login --json | head -50' } },
        true,
      ),
    ).toMatchObject({ kind: 'deny' });
    expect(
      evaluatePreToolUse(
        {
          tool_name: 'Bash',
          tool_input: { command: "node '/repo with spaces/dist/cli.js' affected auth --json | tail -20" },
        },
        true,
      ),
    ).toMatchObject({ kind: 'deny' });
    expect(
      evaluatePreToolUse(
        { tool_name: 'Bash', tool_input: { command: 'npx scip-query refs login --json | head -50' } },
        true,
      ),
    ).toMatchObject({ kind: 'deny' });
    expect(
      evaluatePreToolUse(
        { tool_name: 'Bash', tool_input: { command: 'pnpm exec scip-query affected auth --json | tail -20' } },
        true,
      ),
    ).toMatchObject({ kind: 'deny' });
    expect(
      evaluatePreToolUse(
        { tool_name: 'Bash', tool_input: { command: 'npm exec -- scip-query deps auth --json | head -20' } },
        true,
      ),
    ).toMatchObject({ kind: 'deny' });
    expect(
      evaluatePreToolUse({ tool_name: 'Bash', tool_input: { command: 'scip-query health --json | head -50' } }, true),
    ).toMatchObject({ kind: 'deny' });
    expect(
      evaluatePreToolUse({ tool_name: 'Bash', tool_input: { command: 'scip-query --help | head -50' } }, true),
    ).toEqual({ kind: 'allow' });
  });

  it('interrupts native search only once per context window', () => {
    const payload = { tool_name: 'Grep', tool_input: { pattern: 'login' } };
    expect(evaluatePreToolUse(payload, false)).toMatchObject({
      kind: 'reconsider',
      reason: expect.stringContaining('retry the same search unchanged'),
    });
    expect(evaluatePreToolUse(payload, true)).toEqual({ kind: 'allow' });
  });

  it('provides non-error stop feedback by default', () => {
    const output = renderStopHookOutput(diffGateResult(), resolveStopHookMode({}));

    expect(output).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'Stop',
        additionalContext: expect.stringContaining('non-error Stop hook feedback'),
      },
    });
    expect(output).not.toHaveProperty('decision');
    expect(output).not.toHaveProperty('systemMessage');
  });

  it('can provide non-error stop feedback when explicitly configured', () => {
    const output = renderStopHookOutput(
      diffGateResult(),
      resolveStopHookMode({ SCIP_QUERY_STOP_HOOK_MODE: 'feedback' }),
    );

    expect(output).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'Stop',
        additionalContext: expect.stringContaining('non-error Stop hook feedback'),
      },
    });
    expect(output).not.toHaveProperty('decision');
  });

  it('can block stop hooks when explicitly configured', () => {
    const output = renderStopHookOutput(diffGateResult(), resolveStopHookMode({ SCIP_QUERY_STOP_HOOK_MODE: 'block' }));

    expect(output).toMatchObject({
      decision: 'block',
      reason: expect.stringContaining('fix or knowingly accept them before finishing'),
    });
  });

  it('turns an incomplete gate execution into explicit stop feedback', () => {
    expect(renderStopHookExecutionFailure('timed out after 60000ms', 'feedback')).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'Stop',
        additionalContext: expect.stringContaining('cannot certify this turn'),
      },
    });
    expect(renderStopHookExecutionFailure('another diff-gate is already running', 'block')).toMatchObject({
      decision: 'block',
      reason: expect.stringContaining('already running'),
    });
  });

  it('treats unknown truthy stop mode values as feedback, not block', () => {
    expect(resolveStopHookMode({ SCIP_QUERY_STOP_HOOK_MODE: 'true' })).toBe('feedback');
  });

  it('surfaces incomplete suppression coverage without blocking a finding-free stop', () => {
    const result = {
      ...diffGateResult(),
      findings: [],
      recordCompatibility: {
        suppressions: summarizeRecordCompatibility([
          {
            path: '.scipquery/suppressions/future.json',
            state: 'unsupported-future',
            reason: 'unsupported schemaVersion 2',
          },
        ]),
      },
    };

    const output = renderStopHookOutput(result, 'block');
    expect(output).not.toHaveProperty('decision');
    expect(output).toMatchObject({
      systemMessage: expect.stringContaining('Committed suppression coverage is incomplete'),
    });
  });

  it('keeps an automatically adjudicated stop visible without asking for human approval', () => {
    const finding = diffGateResult().findings[0]!;
    const result: DiffGateResult = {
      ...diffGateResult(),
      findings: [],
      suppressed: [{ finding, suppression: { id: finding.id, reason: 'structured fixture' } }],
      outcome: 'pass-with-suppressions',
      suppressionSummary: {
        automaticSuppressionCount: 1,
        policyEscalationCount: 0,
        expiredCount: 0,
        invalidatedCount: 0,
        legacyUnadjudicatedCount: 0,
      },
    };

    const output = renderStopHookOutput(result, 'feedback');
    expect(output).toMatchObject({
      hookSpecificOutput: {
        additionalContext: expect.stringContaining('pass-with-suppressions'),
      },
    });
    expect(JSON.stringify(output)).toContain('without a human approval prompt');
  });

  it('preserves only relevant analysis, coverage, outcome, and repeat evidence in Stop feedback', () => {
    const result: DiffGateResult = {
      ...diffGateResult(),
      skipped: [{ check: 'architecture', reason: 'baseline unavailable' }],
      evidenceTiers: [
        { tier: 'semantic-consumers', state: 'failed', attemptedSymbols: 1, reason: 'provider unavailable' },
      ],
    };
    const output = renderStopHookOutput(result, 'feedback', {
      outcomes: {
        observed: [{ check: 'doc-reference', findingId: 'doc-reference:example', suppressed: false }],
        now: 2 * 86_400_000,
        warning: 'committed outcome history is incomplete',
        ledger: [
          {
            check: 'doc-reference',
            findingId: 'doc-reference:example',
            firstSeen: 0,
            lastSeen: 2 * 86_400_000,
            timesShown: 2,
            outcome: 'still-open',
          },
        ],
      },
      analysisBudget: {
        scanLimit: 2_500,
        semanticEnrichment: false,
        reason: 'large index default budget; pass --full for unbounded semantic analysis',
      },
    });
    const serialized = JSON.stringify(output);

    expect(serialized).toContain('shown before and unresolved');
    expect(serialized).toContain('Outcome history warning');
    expect(serialized).toContain('Evidence coverage is incomplete');
    expect(serialized).toContain('architecture');
    expect(serialized).toContain('semantic-consumers');
    expect(serialized).toContain('analysis budget');
  });

  it('renders the controller decision without treating unknown predicates as false', () => {
    const execution = {
      outcomes: { observed: [], now: 0 },
      completion: [
        {
          context: {
            record: {
              contextSnapshotId: 'SQCX-0123456789ABCDEF0123456789ABCDEF',
            },
          },
          evaluation: {
            evaluation: {
              record: {
                changeId: 'SQC-0123456789ABCDEF0123456789ABCDEF',
                decision: {
                  state: 'blocked',
                  blockedPredicates: ['goal-fulfilled', 'invariants-preserved'],
                  unknownPredicates: ['goal-fulfilled'],
                },
              },
            },
          },
        },
      ],
    } as unknown as NonNullable<Parameters<typeof renderStopHookOutput>[2]>;

    const feedback = renderStopHookOutput(diffGateResult(), 'feedback', execution);
    const blocking = renderStopHookOutput(diffGateResult(), 'block', execution);

    expect(JSON.stringify(feedback)).toContain('Unknown rather than false: goal-fulfilled');
    expect(blocking).toEqual(
      expect.objectContaining({
        decision: 'block',
        reason: expect.stringContaining('Unsatisfied predicates: goal-fulfilled, invariants-preserved'),
      }),
    );
  });
});

function diffGateResult(): DiffGateResult {
  return {
    base: 'HEAD',
    changedFiles: ['src/example.ts'],
    changedSymbols: 1,
    checksRun: ['doc-reference'],
    skipped: [],
    suppressed: [],
    findings: [
      {
        id: 'doc-reference:example',
        check: 'doc-reference',
        severity: 'warning',
        evidence: 'heuristic',
        message: 'docs/example.md cites src/example.ts as a guide reference - changed in this diff, doc untouched',
        why: ['doc cites a changed file'],
        remediation: 'Verify the guide reference still sends readers to the right implementation.',
      },
    ],
    rootCauseGroups: [],
  };
}

function hookWorkspace(config: Record<string, unknown>) {
  return {
    projectRoot: '/repo',
    config,
    paths: {
      cacheDir: '/cache',
      dbPath: '/cache/index.db',
      indexPath: '/cache/index.scip',
      metaPath: '/cache/meta.json',
    },
  };
}

function watchState(state: 'idle' | 'indexing') {
  return {
    version: 1 as const,
    protocolVersion: 1 as const,
    pid: 123,
    projectRoot: '/repo',
    cliVersion: '0.15.0',
    startedAt: '2026-07-09T20:00:00.000Z',
    heartbeatAt: '2026-07-09T20:00:01.000Z',
    lastActivityAt: '2026-07-09T20:00:01.000Z',
    watcher: state === 'idle' ? ({ state } as const) : ({ state, startedAt: Date.now() } as const),
  };
}
