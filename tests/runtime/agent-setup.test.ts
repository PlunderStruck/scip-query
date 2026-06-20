import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DiffGateResult } from '../../src/queries/impact/diff-gate.js';
import {
  formatGateBlockReason,
  isStopHookReentry,
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
  it('creates AGENTS.md with the block and a CLAUDE.md @AGENTS.md shim on a fresh project', () => {
    const result = setupAgent(projectRoot);

    expect(result.written).toEqual(['AGENTS.md', 'CLAUDE.md']);
    const agentsMd = readFileSync(join(projectRoot, 'AGENTS.md'), 'utf-8');
    expect(agentsMd).toContain('scip-query diff-gate');
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
      suppressed: [],
      findings: [{
        id: 'SQ123456789ABC',
        check: 'incomplete-migration',
        severity: 'warning',
        evidence: 'heuristic',
        message: 'new helper x is wired into 1 file(s), but 2 similar un-migrated site(s) remain',
        why: ['helper x was added in this diff'],
        remediation: 'Migrate the remaining sites to x.',
      }],
    };

    const reason = formatGateBlockReason(result);
    expect(reason).toContain('1 issue(s)');
    expect(reason).toContain('[incomplete-migration]');
    expect(reason).toContain('Migrate the remaining sites to x.');
  });
});
