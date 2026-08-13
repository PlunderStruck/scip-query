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
    expect(agentsMd).toContain('Native text and file tools show matching lines or file slices');
    expect(agentsMd).toContain('exact compiler-owned identities and typed execution');
    expect(agentsMd).toContain('The agent chooses the repository question and relevant controls');
    expect(agentsMd).toContain('without guessing task relevance');
    expect(agentsMd).toContain('scip-query search <exact-text>');
    expect(agentsMd).toContain('scip-query outline <file>');
    expect(agentsMd).toContain('There is no required anchor-discovery phase');
    expect(agentsMd).toContain('repeated `--symbol`, `--at`, or `--search` roots');
    expect(agentsMd).toContain('`--direction incoming|outgoing|both`');
    expect(agentsMd).toContain('`--subtype <subtype>`');
    expect(agentsMd).toContain('`--inventory-only`');
    expect(agentsMd).toContain('`--connecting`');
    expect(agentsMd).toContain('one or more repeated `--edge <family>` flags');
    expect(agentsMd).toContain('`--max-edges <n>`');
    expect(agentsMd).toContain('Treat commands as controls, not a checklist');
    expect(agentsMd).toContain('make each query answer a distinct repository question');
    expect(agentsMd).toContain('There is no mandatory command sequence');
    expect(agentsMd).toContain('or query-count limit');
    expect(agentsMd).toContain('Do not repeat generic synonym searches after usable candidates exist');
    expect(agentsMd).toContain('do not select one by path, naming, apparent recency, or result order');
    expect(agentsMd).toContain('Missing or bounded output is not evidence of absence');
    expect(agentsMd).toContain('candidate observations require confirmation');
    expect(agentsMd).toContain('Batch independent roots and source gaps');
    expect(agentsMd).not.toContain('scip-query system-map');
    expect(agentsMd).not.toContain('scip-query anchors');
    expect(agentsMd).not.toContain('fallback discovery');
    expect(agentsMd).toContain('scip-query inspect');
    expect(agentsMd).toContain('scip-query code <selectors...>');
    expect(agentsMd).not.toContain('scip-query context <target>');
    expect(agentsMd).toContain('scip-query diff-impact');
    expect(agentsMd).toContain('scip-query architecture');
    expect(agentsMd).toContain('scip-query health --full` for configured quality or cleanup detectors');
    expect(agentsMd).toContain('specific unsupported gap reported by scip-query');
    expect(agentsMd).toContain('not a parallel exploration workflow');
    expect(agentsMd).not.toContain('stop-ready');
    expect(agentsMd).not.toContain('Run the emitted `Expand together:`');
    expect(agentsMd).toContain('.scipquery/suppressions/*.json');
    expect(agentsMd).not.toMatch(/evidence ledger|ledger row|final answer audit|Stop hook/i);
    expect(agentsMd).not.toMatch(/diff-gate|Gherkin|goal record|obligation/i);
    expect(agentsMd.length).toBeLessThan(9_000);
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
