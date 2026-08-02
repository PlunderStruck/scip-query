import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DiffGateResult } from '../../src/queries/impact/diff-gate.js';
import {
  evaluateSetupAgentResult,
  formatGateBlockReason,
  removeAgentSetup,
  setupAgent,
} from '../../src/runtime/agent-setup.js';

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'scip-agent-setup-project-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('setupAgent', () => {
  it('derives readiness from actual target outcomes', () => {
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
    expect(
      evaluateSetupAgentResult({
        written: [],
        unchanged: [],
        skipped: [{ target: 'AGENTS.md', reason: 'not writable' }],
      }),
    ).toEqual({ verdict: 'blocked', ready: 0, skipped: 1 });
  });

  it('creates AGENTS.md with the block and a CLAUDE.md @AGENTS.md shim on a fresh project', () => {
    const result = setupAgent(projectRoot);

    expect(result.written).toEqual(['AGENTS.md', 'CLAUDE.md']);
    const agentsMd = readFileSync(join(projectRoot, 'AGENTS.md'), 'utf-8');
    expect(agentsMd).toContain('scip-query diff-gate');
    expect(agentsMd).toContain('derive one concise Gherkin goal');
    expect(agentsMd).toContain('materializes goal, change, plan, and obligations in one action');
    expect(agentsMd).toContain('Do not rerun an exact read-only scip-query command');
    expect(agentsMd).toContain('working diff, index generation, or required coverage scope changed');
    expect(agentsMd).toContain('capture attempts, evidence, reconciliations, and next-action decisions automatically');
    expect(agentsMd).toContain('stop only on a named missing-authorization boundary');
    expect(agentsMd).toContain('do not run those detectors as a fixed pre-gate battery');
    expect(agentsMd).toContain('Give the final diff gate one owner');
    expect(agentsMd).toContain('When protected work activation says Stop is blocking, let Stop run it');
    expect(agentsMd).toContain('Evidence commands obtain a fresh usable index internally');
    expect(agentsMd).toContain('do not add `status`, watcher polling, sleeps, or `reindex`');
    expect(agentsMd).toContain('use the compact contract from `scip-query plan example`');
    expect(agentsMd).toContain('commit `.scipquery/goals/*.json`');
    expect(agentsMd).toContain('`.scipquery/changes/*.json`');
    expect(agentsMd).toContain('`.scipquery/plans/*.json`');
    expect(agentsMd).toContain('`.scipquery/attempts/*.json`');
    expect(agentsMd).toContain('`.scipquery/decisions/*.json`');
    expect(agentsMd).toContain('`.scipquery/obligations/*.json`');
    expect(agentsMd).toContain('`.scipquery/obligation-transitions/*.json`');
    expect(agentsMd).toContain('`.scipquery/completeness-admissions/*.json`');
    expect(agentsMd).toContain('`.scipquery/transition-rules/*.json`');
    expect(agentsMd).toContain('`.scipquery/completion-contexts/*.json`');
    expect(agentsMd).toContain('`.scipquery/completion-evaluations/*.json`');
    expect(agentsMd).toContain('`.scipquery/completion-transitions/*.json`');
    expect(agentsMd).toContain('`.scipquery/suppressions/*.json`');
    expect(agentsMd).toContain('`.scipquery/events/*.json`');
    expect(agentsMd).toContain('`.codex/hooks.json` and `.claude/settings.local.json`');
    expect(agentsMd).toContain('must not be committed');
    expect(agentsMd).toContain('scip-query:agent-setup:begin');
    // Claude Code doesn't read AGENTS.md natively — the shim bridges it.
    const claudeMd = readFileSync(join(projectRoot, 'CLAUDE.md'), 'utf-8');
    expect(claudeMd).toContain('@AGENTS.md');
    expect(claudeMd).toContain('scip-query:agent-setup:begin');
  });

  it('is idempotent — a second run changes nothing', () => {
    setupAgent(projectRoot);
    const second = setupAgent(projectRoot);

    expect(second.written).toEqual([]);
    expect(second.unchanged).toEqual(['AGENTS.md', 'CLAUDE.md']);
  });

  it('appends the shim to an existing CLAUDE.md without touching its content', () => {
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# My project\n\nRules here.\n');

    setupAgent(projectRoot);

    const claudeMd = readFileSync(join(projectRoot, 'CLAUDE.md'), 'utf-8');
    expect(claudeMd).toContain('# My project');
    expect(claudeMd).toContain('@AGENTS.md');
    // The canonical block lives in AGENTS.md, not duplicated into CLAUDE.md.
    expect(claudeMd).not.toContain('scip-query plan-context');
    // Re-run replaces the managed block rather than appending a duplicate.
    setupAgent(projectRoot);
    const again = readFileSync(join(projectRoot, 'CLAUDE.md'), 'utf-8');
    expect(again.match(/scip-query:agent-setup:begin/g)).toHaveLength(1);
  });

  it('leaves CLAUDE.md alone when the user already imports AGENTS.md', () => {
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# Shim\n\n@AGENTS.md\n');

    const result = setupAgent(projectRoot);

    expect(result.unchanged).toContain('CLAUDE.md');
    expect(readFileSync(join(projectRoot, 'CLAUDE.md'), 'utf-8')).toBe('# Shim\n\n@AGENTS.md\n');
  });

  it('reports malformed managed markers without changing user prose', () => {
    const path = join(projectRoot, 'AGENTS.md');
    const malformed = '# Notes\n\n<!-- scip-query:agent-setup:begin -->\ncustom work\n';
    writeFileSync(path, malformed);

    const result = setupAgent(projectRoot);

    expect(result.skipped).toContainEqual({
      target: 'AGENTS.md',
      reason: 'managed scip-query markers are incomplete, duplicated, or out of order',
    });
    expect(readFileSync(path, 'utf8')).toBe(malformed);
  });

  it('installs an executable git pre-commit hook when asked', () => {
    mkdirSync(join(projectRoot, '.git', 'hooks'), { recursive: true });

    const result = setupAgent(projectRoot, { gitHook: true });

    expect(result.written).toContain('.git/hooks/pre-commit');
    const hookPath = join(projectRoot, '.git', 'hooks', 'pre-commit');
    expect(readFileSync(hookPath, 'utf-8')).toContain('scip-query diff-gate');
    expect(statSync(hookPath).mode & 0o100).toBeTruthy();
  });

  it('refuses to touch a foreign pre-commit hook', () => {
    mkdirSync(join(projectRoot, '.git', 'hooks'), { recursive: true });
    const hookPath = join(projectRoot, '.git', 'hooks', 'pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\nmake lint\n');
    chmodSync(hookPath, 0o755);

    const result = setupAgent(projectRoot, { gitHook: true });

    expect(result.skipped.some((skip) => skip.target === '.git/hooks/pre-commit')).toBe(true);
    expect(readFileSync(hookPath, 'utf-8')).toContain('make lint');
  });

  it('skips the git hook gracefully outside a repository', () => {
    const result = setupAgent(projectRoot, { gitHook: true });

    expect(result.skipped.some((skip) => skip.target === '.git/hooks/pre-commit')).toBe(true);
    expect(result.written).toEqual(['AGENTS.md', 'CLAUDE.md']);
  });

  it('removes only managed setup artifacts', () => {
    mkdirSync(join(projectRoot, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(projectRoot, 'AGENTS.md'), '# Existing notes\n\n');
    setupAgent(projectRoot, { gitHook: true });

    const result = removeAgentSetup(projectRoot);

    expect(result.removed).toEqual(['AGENTS.md', 'CLAUDE.md', '.git/hooks/pre-commit']);
    expect(readFileSync(join(projectRoot, 'AGENTS.md'), 'utf-8')).toBe('# Existing notes\n');
    expect(() => readFileSync(join(projectRoot, 'CLAUDE.md'), 'utf-8')).toThrow();
    expect(() => readFileSync(join(projectRoot, '.git', 'hooks', 'pre-commit'), 'utf-8')).toThrow();
  });

  it('does not remove a block whose markers were reordered', () => {
    const path = join(projectRoot, 'AGENTS.md');
    const malformed = [
      '# Notes',
      '<!-- scip-query:agent-setup:end -->',
      'custom work',
      '<!-- scip-query:agent-setup:begin -->',
      '',
    ].join('\n');
    writeFileSync(path, malformed);

    const result = removeAgentSetup(projectRoot);

    expect(result.skipped).toContainEqual({
      target: 'AGENTS.md',
      reason: 'managed scip-query markers are incomplete, duplicated, or out of order',
    });
    expect(readFileSync(path, 'utf8')).toBe(malformed);
  });
});

describe('stop-hook helpers (diff-gate --hook)', () => {
  it('formats a block reason with every finding and its remediation', () => {
    const result: DiffGateResult = {
      base: 'HEAD',
      changedFiles: ['a.ts'],
      changedSymbols: 1,
      checksRun: ['incomplete-migration'],
      skipped: [],
      suppressed: [],
      findings: [
        {
          id: 'SQ123456789ABC',
          check: 'incomplete-migration',
          severity: 'warning',
          evidence: 'heuristic',
          message: 'new helper x is wired into 1 file(s), but 2 similar un-migrated site(s) remain',
          why: ['helper x was added in this diff'],
          remediation: 'Migrate the remaining sites to x.',
        },
      ],
    };

    const reason = formatGateBlockReason(result);
    expect(reason).toContain('1 issue(s)');
    expect(reason).toContain('1 root-cause group(s)');
    expect(reason).toContain('[incomplete-migration]');
    expect(reason).toContain('Migrate the remaining sites to x.');
  });
});
