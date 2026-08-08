import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evaluateSetupAgentResult, removeAgentSetup, setupAgent } from '../../src/runtime/agent-setup.js';

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'scip-agent-setup-project-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('setupAgent', () => {
  it('derives readiness from the files it could manage', () => {
    expect(evaluateSetupAgentResult({ written: ['AGENTS.md'], unchanged: ['CLAUDE.md'], skipped: [] })).toEqual({
      verdict: 'ready',
      ready: 2,
      skipped: 0,
    });
    expect(
      evaluateSetupAgentResult({
        written: ['AGENTS.md'],
        unchanged: [],
        skipped: [{ target: 'CLAUDE.md', reason: 'not writable' }],
      }),
    ).toEqual({ verdict: 'partial', ready: 1, skipped: 1 });
  });

  it('installs concise mapping guidance without lifecycle ceremony', () => {
    const result = setupAgent(projectRoot);

    expect(result.written).toEqual(['AGENTS.md', 'CLAUDE.md']);
    const agentsMd = readFileSync(join(projectRoot, 'AGENTS.md'), 'utf8');
    expect(agentsMd).toContain('separates two responsibilities');
    expect(agentsMd).toContain('the agent decides what repository fact it needs');
    expect(agentsMd).toContain('without guessing task relevance');
    expect(agentsMd).toContain('state the few material repository facts');
    expect(agentsMd).toContain('scip-query search <exact-text>');
    expect(agentsMd).toContain('scip-query outline <file>');
    expect(agentsMd).toContain('There is no required anchor-discovery phase');
    expect(agentsMd).toContain('repeated `--symbol`, `--at`, or `--search` selectors');
    expect(agentsMd).toContain('`--direction incoming|outgoing|both`');
    expect(agentsMd).toContain('`--subtype <subtype>`');
    expect(agentsMd).toContain('`--inventory-only`');
    expect(agentsMd).toContain('`--connecting`');
    expect(agentsMd).toContain('`causal` covers execution, runtime, dataflow, state, and temporal relationships');
    expect(agentsMd).toContain('`structure` covers contract, identity, ownership, and dependencies');
    expect(agentsMd).toContain('the agent chooses what can establish its claim');
    expect(agentsMd).toContain(
      'the CLI resolves identity, direction, evidence strength, provider support, and coverage',
    );
    expect(agentsMd).toContain('execution calls and exact runtime handoffs');
    expect(agentsMd).toContain('they do not become call claims');
    expect(agentsMd).toContain('`accounted` means');
    expect(agentsMd).toContain('`bounded` means');
    expect(agentsMd).toContain('`incomplete` means');
    expect(agentsMd).toContain('stable recoverable folds');
    expect(agentsMd).toContain('one locator, one batched projection, and at most one batched gap read');
    expect(agentsMd).toContain('batch independent roots and gaps');
    expect(agentsMd).toContain('system-map` and `scip-query anchors` are compatibility views');
    expect(agentsMd).toContain('no next target is automatically recommended');
    expect(agentsMd).not.toContain('fallback discovery');
    expect(agentsMd).toContain('singleton, shared registry, per-session instance, or per-invocation value');
    expect(agentsMd).toContain('exact scope of every bypass');
    expect(agentsMd).toContain('Resolve exact constant values');
    expect(agentsMd).toContain('scip-query inspect');
    expect(agentsMd).toContain('scip-query code <symbol-or-range>');
    expect(agentsMd).toContain('scip-query context <target>');
    expect(agentsMd).toContain('scip-query diff-impact');
    expect(agentsMd).toContain('scip-query architecture');
    expect(agentsMd).toContain('React, Vue, duplication, complexity, drift, and cleanup candidates');
    expect(agentsMd).toContain('specific unsupported gap');
    expect(agentsMd).toContain('not a parallel exploration workflow');
    expect(agentsMd).not.toContain('stop-ready');
    expect(agentsMd).not.toContain('Run the emitted `Expand together:`');
    expect(agentsMd).toContain('.scipquery/suppressions/*.json');
    expect(agentsMd).not.toMatch(/diff-gate|Gherkin|goal record|obligation/i);
    expect(readFileSync(join(projectRoot, 'CLAUDE.md'), 'utf8')).toContain('@AGENTS.md');
  });

  it('is idempotent', () => {
    setupAgent(projectRoot);
    expect(setupAgent(projectRoot)).toMatchObject({
      written: [],
      unchanged: ['AGENTS.md', 'CLAUDE.md'],
      skipped: [],
    });
  });

  it('preserves existing instructions around its managed block', () => {
    writeFileSync(join(projectRoot, 'AGENTS.md'), '# Team rules\n');
    setupAgent(projectRoot);

    const agentsMd = readFileSync(join(projectRoot, 'AGENTS.md'), 'utf8');
    expect(agentsMd).toContain('# Team rules');
    expect(agentsMd.match(/scip-query:agent-setup:begin/g)).toHaveLength(1);
  });

  it('reports malformed markers without overwriting them', () => {
    const malformed = '# Notes\n\n<!-- scip-query:agent-setup:begin -->\ncustom work\n';
    writeFileSync(join(projectRoot, 'AGENTS.md'), malformed);

    const result = setupAgent(projectRoot);

    expect(result.skipped).toContainEqual({
      target: 'AGENTS.md',
      reason: 'managed scip-query markers are incomplete, duplicated, or out of order',
    });
    expect(readFileSync(join(projectRoot, 'AGENTS.md'), 'utf8')).toBe(malformed);
  });

  it('removes the managed guidance and a legacy scip-query pre-commit hook', () => {
    mkdirSync(join(projectRoot, '.git', 'hooks'), { recursive: true });
    setupAgent(projectRoot);
    writeFileSync(join(projectRoot, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n# scip-query:agent-setup\n');

    const result = removeAgentSetup(projectRoot);

    expect(result.removed).toEqual(['AGENTS.md', 'CLAUDE.md', '.git/hooks/pre-commit']);
    expect(existsSync(join(projectRoot, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(projectRoot, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(projectRoot, '.git', 'hooks', 'pre-commit'))).toBe(false);
  });

  it('does not remove a foreign pre-commit hook', () => {
    mkdirSync(join(projectRoot, '.git', 'hooks'), { recursive: true });
    const hookPath = join(projectRoot, '.git', 'hooks', 'pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\nmake lint\n');

    const result = removeAgentSetup(projectRoot);

    expect(result.skipped).toContainEqual({
      target: '.git/hooks/pre-commit',
      reason: 'pre-commit hook is not managed by scip-query',
    });
    expect(readFileSync(hookPath, 'utf8')).toContain('make lint');
  });
});
