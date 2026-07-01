import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DiffGateResult } from '../../src/queries/impact/diff-gate.js';
import {
  renderAgentHookContext,
  renderStopHookOutput,
  renderUserPromptContext,
  resolveStopHookMode,
  routesForPrompt,
} from '../../src/runtime/agent-hooks.js';

describe('agent hook context', () => {
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
    expect(context).not.toContain('scip-debug');
    expect(context).not.toContain('scip-diagram');
  });

  it('skips drive-by single-keyword prompts unless a skill is explicit', () => {
    expect(renderUserPromptContext('Please review this')).toBe('');
    expect(routesForPrompt('Please use scip-debug on this')).toMatchObject({ id: 'debug' });
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

    expect(context).toContain('scip-cleanup-audit');
    expect(context).toContain('scip-cleanup-improve');
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
