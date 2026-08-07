import { describe, expect, it } from 'vitest';
// Native benchmark runners intentionally remain ESM scripts outside the shipped TypeScript tree.
// @ts-expect-error native script modules do not ship TypeScript declarations
import {
  classifyExplorationCommand,
  disciplinedControlPrompt,
  minimalTreatmentPrompt,
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

  it('makes lossless scip-only exploration and selective expansion explicit', () => {
    const prompt = treatmentPrompt('How does the path work?');
    expect(prompt).toContain('scip-query as the only repository exploration surface');
    expect(prompt).toContain('cross-boundary-flow');
    expect(prompt).toContain('parallel-paths');
    expect(prompt).toContain('connected-flow whose displayed roots already cover every named material part');
    expect(prompt).toContain('Do not choose a set merely because it is connected');
    expect(prompt).toContain('reject any set whose displayed roots and matched terms omit');
    expect(prompt).toContain('first ranked eligible set');
    expect(prompt).toContain('upstream callers');
    expect(prompt).toContain('result-producing callbacks');
    expect(prompt).toContain('Use exactly one initial locator');
    expect(prompt).toContain('one shell-safely quoted positional argument');
    expect(prompt).toContain('operation kind and record-identity fields');
    expect(prompt).toContain('handler-resolution precedence');
    expect(prompt).toContain('fallback or unknown-handler behavior');
    expect(prompt).toContain('exception-to-result conversion');
    expect(prompt).toContain("Run the chosen set's printed system-map command unchanged");
    expect(prompt).toContain('never pass the same loose term to both selectors');
    expect(prompt).toContain('Do not run inspect, evidence, code, or command help before the map');
    expect(prompt).toContain('connected behavior is already source evidence');
    expect(prompt).toContain('private evidence ledger');
    expect(prompt).toContain('one ledger row per material claim');
    expect(prompt).toContain('A constant name is not a recovered bound');
    expect(prompt).toContain('sibling branches are jointly required behavior');
    expect(prompt).toContain('stop immediately when they establish all of them');
    expect(prompt).toContain('one locator, one map, one scoped gap batch');
    expect(prompt).toContain('must use the remaining semantic-query allowance for one final batched recovery inspect');
    expect(prompt).toContain('do not report a coverage limitation for an exact in-budget recovery command');
    expect(prompt).toContain('evidence seen but left implicit is not recovered');
    expect(prompt).toContain('Optional causal recovery is folded by default');
    expect(prompt).toContain('--gap-callee');
    expect(prompt).toContain('--gap-recovery-only');
    expect(prompt).toContain('ranking is navigation help, not a claim');
    expect(prompt).toContain('shared-callee-owners');
    expect(prompt).toContain('Do not use rg');
    expect(prompt).toContain('poll the existing terminal execution session');
    expect(prompt).toContain('The map and source inspection are sequential, never parallel');
    expect(prompt).toContain('Inspection selection is invalid until the map has completed');
    expect(prompt).toContain('Never run ps');
    expect(prompt).toContain('Never use perl to print it');
  });

  it('supports prompt ablations without leaking task-specific navigation', () => {
    const minimal = minimalTreatmentPrompt('How does the path work?');
    expect(minimal).toContain('scip-query as the only repository exploration surface');
    expect(minimal).toContain('whatever scip-query commands you judge necessary');
    expect(minimal).not.toContain('exactly one initial locator');

    const disciplined = disciplinedControlPrompt('How does the path work?');
    expect(disciplined).toContain('Do not run scip-query');
    expect(disciplined).toContain('few material claims');
    expect(disciplined).toContain('Batch independent searches and reads');
    expect(disciplined).not.toContain('system-map');
  });
});
