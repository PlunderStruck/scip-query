import { describe, expect, it } from 'vitest';
// Native benchmark runners intentionally remain ESM scripts outside the shipped TypeScript tree.
// @ts-expect-error native script modules do not ship TypeScript declarations
import {
  classifyExplorationCommand,
  parseCodexJsonl,
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
          exitCode: 0,
        },
      ],
      usage: { inputTokens: 30, cachedInputTokens: 10, outputTokens: 5, reasoningOutputTokens: 2 },
    });
    expect(parsed.calls[0].outputSha256).toHaveLength(64);
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
    expect(classifyExplorationCommand('pwd')).toEqual({ surface: 'other', kind: 'other' });
  });

  it('makes lossless scip-only exploration and selective expansion explicit', () => {
    const prompt = treatmentPrompt('How does the path work?');
    expect(prompt).toContain('scip-query as the only repository exploration surface');
    expect(prompt).toContain('at most one locating search');
    expect(prompt).toContain('make system-map the first graph/detail operation');
    expect(prompt).toContain('never pass the same loose term to both selectors');
    expect(prompt).toContain('Do not run inspect, evidence, code, or command help before the map');
    expect(prompt).toContain('connected behavior is already source evidence');
    expect(prompt).toContain('stop immediately when they establish all of them');
    expect(prompt).toContain('one locating query, one map, and at most one batched gap query');
    expect(prompt).toContain('evidence seen but left implicit is not recovered');
    expect(prompt).toContain('Do not use rg');
  });
});
