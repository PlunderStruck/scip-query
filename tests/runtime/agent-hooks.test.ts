import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DiffGateResult } from '../../src/queries/impact/diff-gate.js';
import {
  evaluatePreToolUse,
  renderAgentHookContext,
  refreshIndexForHookIfNeeded,
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

  it('blocks blind truncation for commands with compact or paginated alternatives', () => {
    expect(
      evaluatePreToolUse(
        { tool_name: 'Bash', tool_input: { command: 'scip-query refs login --json | head -50' } },
        true,
      ),
    ).toMatchObject({ kind: 'deny', reason: expect.stringContaining('--limit') });
    expect(
      evaluatePreToolUse(
        { tool_name: 'Bash', tool_input: { command: "scip-query diff-gate --json | sed -n '1,80p'" } },
        true,
      ),
    ).toMatchObject({ kind: 'deny', reason: expect.stringContaining('--compact') });
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
      evaluatePreToolUse({ tool_name: 'Bash', tool_input: { command: 'scip-query health --json | head -50' } }, true),
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

  it('treats unknown truthy stop mode values as feedback, not block', () => {
    expect(resolveStopHookMode({ SCIP_QUERY_STOP_HOOK_MODE: 'true' })).toBe('feedback');
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
