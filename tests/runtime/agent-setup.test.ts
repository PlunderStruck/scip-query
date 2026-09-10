import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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

  it('keeps CLAUDE.md as a symbolic link to AGENTS.md and writes the guidance once', () => {
    writeFileSync(join(projectRoot, 'AGENTS.md'), '# Project\n');
    symlinkSync('AGENTS.md', join(projectRoot, 'CLAUDE.md'));

    const result = setupAgent(projectRoot);

    expect(result.written).toEqual(['AGENTS.md']);
    expect(result.unchanged).toEqual(['CLAUDE.md']);
    expect(result.skipped).toEqual([]);
    expect(lstatSync(join(projectRoot, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
    const agentsMd = readFileSync(join(projectRoot, 'AGENTS.md'), 'utf8');
    expect(agentsMd.split('<!-- scip-query:agent-setup:begin -->')).toHaveLength(2);
    expect(readFileSync(join(projectRoot, 'CLAUDE.md'), 'utf8')).toBe(agentsMd);
  });

  it('installs concise mapping guidance without lifecycle ceremony', () => {
    const result = setupAgent(projectRoot);

    expect(result.written).toEqual(['AGENTS.md', 'CLAUDE.md']);
    const agentsMd = readFileSync(join(projectRoot, 'AGENTS.md'), 'utf8');
    expect(agentsMd).toContain('Use ordinary file tools for source search and reading');
    for (const command of [
      'system --source',
      'context',
      'evidence',
      'health',
      'review',
      'diff-impact',
      'architecture',
    ]) {
      expect(agentsMd).toContain(`scip-query ${command}`);
    }
    expect(agentsMd).toContain('existing implementation path, comparable features, shared owners');
    expect(agentsMd).toContain('--edge execution --direction incoming --depth 1 --max-edges 30');
    expect(agentsMd).toContain('Material missing, stale or unsupported evidence');
    expect(agentsMd).toContain('Read saved results selectively with normal file tools');
    expect(agentsMd).toContain('--json --json-output <path>');
    expect(agentsMd).toContain('Do not drain pages');
    expect(agentsMd).toContain('.scipquery/suppressions/*.json');
    expect(agentsMd).not.toMatch(
      /required transport|not a parallel exploration workflow|evidence ledger|ledger row|final answer audit|Stop hook/i,
    );
    expect(agentsMd.length).toBeLessThan(4_500);
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
