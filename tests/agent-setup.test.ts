import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DiffGateResult } from '../src/queries/diff-gate.js';
import {
  formatGateBlockReason,
  isStopHookReentry,
  setupAgent,
} from '../src/runtime/agent-setup.js';

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'scip-agent-setup-project-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('setupAgent', () => {
  it('creates AGENTS.md with the managed block on a fresh project', () => {
    const result = setupAgent(projectRoot);

    expect(result.written).toEqual(['AGENTS.md']);
    const agentsMd = readFileSync(join(projectRoot, 'AGENTS.md'), 'utf-8');
    expect(agentsMd).toContain('scip-query diff-gate');
    expect(agentsMd).toContain('scip-query:agent-setup:begin');
  });

  it('is idempotent — a second run changes nothing', () => {
    setupAgent(projectRoot);
    const second = setupAgent(projectRoot);

    expect(second.written).toEqual([]);
    expect(second.unchanged).toEqual(['AGENTS.md']);
  });

  it('updates existing instruction files instead of creating AGENTS.md', () => {
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# My project\n\nRules here.\n');

    setupAgent(projectRoot);

    expect(existsSync(join(projectRoot, 'AGENTS.md'))).toBe(false);
    const claudeMd = readFileSync(join(projectRoot, 'CLAUDE.md'), 'utf-8');
    expect(claudeMd).toContain('# My project');
    expect(claudeMd).toContain('scip-query diff-gate');
    // Re-run replaces the managed block rather than appending a duplicate.
    setupAgent(projectRoot);
    const again = readFileSync(join(projectRoot, 'CLAUDE.md'), 'utf-8');
    expect(again.match(/scip-query:agent-setup:begin/g)).toHaveLength(1);
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
    expect(result.written).toEqual(['AGENTS.md']);
  });
});

describe('stop-hook helpers (diff-gate --hook)', () => {
  it('detects reentry from stop_hook_active', () => {
    expect(isStopHookReentry(JSON.stringify({ stop_hook_active: true }))).toBe(true);
    expect(isStopHookReentry(JSON.stringify({ stop_hook_active: false }))).toBe(false);
    expect(isStopHookReentry(JSON.stringify({ hook_event_name: 'Stop' }))).toBe(false);
    expect(isStopHookReentry('')).toBe(false);
    expect(isStopHookReentry('not json')).toBe(false);
  });

  it('formats a block reason with every finding and its remediation', () => {
    const result: DiffGateResult = {
      base: 'HEAD',
      changedFiles: ['a.ts'],
      changedSymbols: 1,
      checksRun: ['incomplete-migration'],
      skipped: [],
      findings: [{
        check: 'incomplete-migration',
        message: 'new helper x is wired into 1 file(s), but 2 similar un-migrated site(s) remain',
        remediation: 'Migrate the remaining sites to x.',
      }],
    };

    const reason = formatGateBlockReason(result);
    expect(reason).toContain('1 issue(s)');
    expect(reason).toContain('[incomplete-migration]');
    expect(reason).toContain('Migrate the remaining sites to x.');
  });
});
