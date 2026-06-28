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

  it('routes user prompts toward relevant scip skills', () => {
    const context = renderUserPromptContext('Please debug this failing setup and then draw a diagram of the flow');

    expect(context).toContain('scip-debug');
    expect(context).toContain('scip-diagram');
    expect(context).toContain('scip-adoption');
  });

  it('routes health score prompts toward autonomous improvement', () => {
    const context = renderUserPromptContext('Raise the health score as high as reasonably possible');

    expect(context).toContain('scip-health-audit');
    expect(context).toContain('scip-health-improve');
  });

  it('warns without blocking stop hooks by default', () => {
    const output = renderStopHookOutput(diffGateResult(), resolveStopHookMode({}));

    expect(output).toMatchObject({
      systemMessage: expect.stringContaining('Stop hook allowed this turn to finish'),
    });
    expect(output).not.toHaveProperty('decision');
    expect(output).not.toHaveProperty('hookSpecificOutput');
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
