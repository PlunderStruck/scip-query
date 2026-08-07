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
    expect(agentsMd).toContain('repository exploration sensor');
    expect(agentsMd).toContain('Locate referents in exact indexed text');
    expect(agentsMd).toContain('orient them by compiler identity and construct ownership');
    expect(agentsMd).toContain('navigate typed compiler and runtime relationships');
    expect(agentsMd).toContain('require every omitted direction');
    expect(agentsMd).toContain('read connected behavior');
    expect(agentsMd).toContain('retrieve exact current source');
    expect(agentsMd).toContain('scip-query system-map');
    expect(agentsMd).toContain('shared-callee-owners');
    expect(agentsMd).toContain('parallel-paths');
    expect(agentsMd).toContain('connected-flow` whose displayed roots already cover every named material part');
    expect(agentsMd).toContain('Do not choose a set merely because it is connected');
    expect(agentsMd).toContain('reject any set whose displayed roots and matched terms omit');
    expect(agentsMd).toContain('first ranked eligible set');
    expect(agentsMd).toContain('upstream callers');
    expect(agentsMd).toContain('result-producing callbacks');
    expect(agentsMd).toContain('Anchor roots are locator evidence, not behavior evidence');
    expect(agentsMd).toContain('The map and inspection are sequential, never parallel');
    expect(agentsMd).toContain('Do not force both');
    expect(agentsMd).toContain('never pass the same loose term to both selectors');
    expect(agentsMd).toContain('evidence seen but left implicit is not recovered');
    expect(agentsMd).toContain('one ledger row per material claim');
      expect(agentsMd).toContain('A constant name is not a recovered bound');
      expect(agentsMd).toContain('Do not inspect an explicit anchor or any source line already rendered');
    expect(agentsMd).toContain('--full-literal-traversal');
    expect(agentsMd).toContain('query connector graph');
    expect(agentsMd).toContain('accounted frontiers');
    expect(agentsMd).toContain('never expand every region');
    expect(agentsMd).toContain('name the fact still missing');
    expect(agentsMd).toContain('complete normalized outline');
    expect(agentsMd).toContain('unsupported statements remain verbatim');
    expect(agentsMd).toContain('scip-query search <text>');
    expect(agentsMd).toContain('scip-query inspect');
    expect(agentsMd).toContain('Do not inventory one file or symbol at a time');
    expect(agentsMd).toContain('scip-query evidence <symbol>');
    expect(agentsMd).toContain('scip-query context <target>');
    expect(agentsMd).toContain('scip-query diff-impact');
    expect(agentsMd).toContain('scip-query architecture');
    expect(agentsMd).toContain('React, Vue, duplication, complexity, drift, and cleanup candidates');
    expect(agentsMd).toContain('exact runtime-boundary findings');
    expect(agentsMd).toContain('specific unsupported gap');
    expect(agentsMd).toContain('not a parallel exploration workflow');
    expect(agentsMd).toContain('selection-complete');
    expect(agentsMd).toContain('connector-complete');
    expect(agentsMd).toContain('frontier-accounted');
    expect(agentsMd).toContain('coverage-incomplete');
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
