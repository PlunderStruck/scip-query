import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
// Native benchmark runners intentionally remain ESM scripts outside the shipped TypeScript tree.
// @ts-expect-error native script modules do not ship TypeScript declarations
import {
  classifyExplorationCommand,
  directGraphTreatmentPrompt,
  disciplinedControlPrompt,
  minimalTreatmentPrompt,
  parseCodexJsonl,
  pathWithoutExecutable,
  treatmentPrompt,
} from '../../scripts/codex-exploration-trial-core.mjs';

describe('Codex exploration trial core', () => {
  it('parses completed commands, the final answer, and cumulative model usage', () => {
    const parsed = parseCodexJsonl(
      [
        JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'command_execution',
            command: 'scip-query system-map --symbol writer --symbol reader',
            aggregated_output: 'proved path',
            exit_code: 0,
          },
        }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final answer' } }),
        JSON.stringify({
          type: 'turn.completed',
          usage: {
            input_tokens: 30,
            cached_input_tokens: 10,
            output_tokens: 5,
            reasoning_output_tokens: 2,
          },
        }),
      ].join('\n'),
      { benchmarkId: 'fixture' },
    );

    expect(parsed).toMatchObject({
      benchmarkId: 'fixture',
      answer: 'final answer',
      codexThreadId: 'thread-1',
      calls: [
        {
          surface: 'scip-query',
          kind: 'query',
          outputCharacters: 11,
          preconditionRefusal: false,
          exitCode: 0,
        },
      ],
      usage: { inputTokens: 30, cachedInputTokens: 10, outputTokens: 5, reasoningOutputTokens: 2 },
    });
    expect(parsed.calls[0].outputSha256).toHaveLength(64);
  });

  it('records a navigation precondition refusal without retaining command output', () => {
    const parsed = parseCodexJsonl(
      [
        JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'command_execution',
            command: 'scip-query inspect --at src/file.ts:1',
            aggregated_output: 'error: NAVIGATION MAP REQUIRED',
            exit_code: 1,
          },
        }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final answer' } }),
        JSON.stringify({
          type: 'turn.completed',
          usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
        }),
      ].join('\n'),
      { benchmarkId: 'fixture' },
    );

    expect(parsed.calls[0]).toMatchObject({ preconditionRefusal: true, exitCode: 1, output: '' });
  });

  it('classifies a duplicate map refusal as a precondition rather than semantic work', () => {
    const parsed = parseCodexJsonl(
      [
        JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'command_execution',
            command: 'scip-query system-map --symbol target',
            aggregated_output: 'error: MAP TRANSPORT INCOMPLETE\nContinue exactly: scip-query continue abc',
            exit_code: 1,
          },
        }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final answer' } }),
        JSON.stringify({
          type: 'turn.completed',
          usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
        }),
      ].join('\n'),
      { benchmarkId: 'fixture' },
    );

    expect(parsed.calls[0]).toMatchObject({ preconditionRefusal: true, exitCode: 1 });
  });

  it('classifies native exploration before a mixed scip-query pipeline can hide it', () => {
    expect(classifyExplorationCommand('scip-query code thing | sed -n 1,20p')).toEqual({
      surface: 'native-read',
      kind: 'query',
    });
    expect(classifyExplorationCommand('SCIP_QUERY_SESSION=x scip-query status --capabilities')).toEqual({
      surface: 'scip-query',
      kind: 'status',
    });
    expect(classifyExplorationCommand("/bin/zsh -lc 'scip-query search handler'")).toEqual({
      surface: 'scip-query',
      kind: 'query',
    });
    expect(classifyExplorationCommand("/bin/zsh -lc '/opt/homebrew/bin/scip-query continue abc.2'")).toEqual({
      surface: 'scip-query',
      kind: 'continuation',
    });
    expect(classifyExplorationCommand("perl -0pe 's/x/y/' skills/scip-query/SKILL.md")).toEqual({
      surface: 'other',
      kind: 'other',
    });
    expect(classifyExplorationCommand("sed -n '1,100p' src/index.ts skills/scip-query/SKILL.md")).toEqual({
      surface: 'native-read',
      kind: 'query',
    });
    expect(
      classifyExplorationCommand(
        '/bin/zsh -lc "ruby -e \'STDOUT.write(File.read("/repo/skills/scip-query/SKILL.md"))\'"',
      ),
    ).toEqual({ surface: 'other', kind: 'other' });
    expect(classifyExplorationCommand('rg -n handler src')).toEqual({ surface: 'native-search', kind: 'query' });
    expect(classifyExplorationCommand('ps -ax -o pid=,command=')).toEqual({
      surface: 'native-search',
      kind: 'query',
    });
    expect(classifyExplorationCommand("scip-query anchors 'How does it find configuration?'")).toEqual({
      surface: 'scip-query',
      kind: 'query',
    });
    expect(classifyExplorationCommand('pwd')).toEqual({ surface: 'other', kind: 'other' });
  });

  it('delegates exploration semantics to installed repository guidance', () => {
    const prompt = treatmentPrompt('How does the path work?');
    expect(prompt).toContain('scip-query as the only repository exploration surface');
    expect(prompt).toContain('follow the installed repository scip-query guidance');
    expect(prompt).toContain('no query-count correctness cutoff');
    expect(prompt).not.toContain('target of 4 queries');
    expect(prompt).not.toContain('First run scip-query status');
    expect(prompt).not.toContain('Prefer one batched query');
    expect(prompt).not.toContain('Batch compatible selected roots');
    expect(prompt).not.toContain('provider provenance');
    expect(prompt).toContain('Do not use native repository search or source-reading tools');
    expect(prompt.length).toBeLessThan(1_400);
  });

  it('supports prompt ablations without leaking task-specific navigation', () => {
    const minimal = minimalTreatmentPrompt('How does the path work?');
    expect(minimal).toContain('scip-query as the only repository exploration surface');
    expect(minimal).toContain('installed repository scip-query guidance');
    expect(minimal).not.toContain('exactly one initial locator');

    const disciplined = disciplinedControlPrompt('How does the path work?');
    expect(disciplined).toContain('Do not run scip-query');
    expect(disciplined).toContain('few material claims');
    expect(disciplined).toContain('Batch independent searches and reads');
    expect(disciplined).not.toContain('system-map');
  });

  it('supports direct graph navigation without requiring anchor discovery', () => {
    const prompt = directGraphTreatmentPrompt('How does the path work?');

    expect(prompt).toContain('follow the installed repository scip-query guidance');
    expect(prompt).toContain('use the explicit evidence family and direction');
    expect(prompt).toContain('no query-count correctness cutoff');
    expect(prompt).not.toContain('The normal exploration budget is');
    expect(prompt).not.toContain("scip-query evidence --symbol '<first>'");
    expect(prompt).not.toContain("Run the chosen set's printed system-map command unchanged");
  });

  it('removes every PATH directory that could expose the treatment executable to a control', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-query-control-path-'));
    try {
      const clean = join(root, 'clean');
      const contaminated = join(root, 'contaminated');
      mkdirSync(clean);
      mkdirSync(contaminated);
      writeFileSync(join(contaminated, 'scip-query'), '#!/bin/sh\n');

      expect(pathWithoutExecutable([contaminated, clean].join(delimiter), 'scip-query')).toBe(clean);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
