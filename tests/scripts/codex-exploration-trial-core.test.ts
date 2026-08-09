import { describe, expect, it } from 'vitest';
// Native benchmark runners intentionally remain ESM scripts outside the shipped TypeScript tree.
// @ts-expect-error native script modules do not ship TypeScript declarations
import {
  classifyExplorationCommand,
  directGraphTreatmentPrompt,
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

  it('makes explicit, bounded, query-neutral graph exploration the treatment contract', () => {
    const prompt = treatmentPrompt('How does the path work?', 4);
    expect(prompt).toContain('scip-query as the only repository exploration surface');
    expect(prompt).toContain('efficiency against a target of 4 queries');
    expect(prompt).toContain('this is not a correctness cutoff');
    expect(prompt).toContain('status --capabilities only if');
    expect(prompt).not.toContain('First run scip-query status');
    expect(prompt).toContain('Prefer one batched query to locate exact referents');
    expect(prompt).toContain('Batch compatible selected roots into a scip-query evidence call');
    expect(prompt).toContain('Keep graph projection separate from source materialization');
    expect(prompt).toContain('do not add --include to a graph request');
    expect(prompt).toContain('Repeat only while a named claim remains unresolved');
    expect(prompt).toContain('Explicitly choose incoming, outgoing, or both');
    expect(prompt).toContain('edge families or exact subtypes');
    expect(prompt).toContain('provider provenance');
    expect(prompt).toContain('stable folds');
    expect(prompt).toContain('Data, state, temporal, contract, identity, ownership, and dependency edges');
    expect(prompt).toContain('A named constant is not an established value');
    expect(prompt).toContain('evidence seen but omitted from the answer is not recovered');
    expect(prompt).toContain('ordering is candidate presentation, not inferred relevance');
    expect(prompt).toContain('Do not use anchor groups, selection terms, automatic routes, next-anchor scores');
    expect(prompt).not.toContain('first ranked eligible set');
    expect(prompt).not.toContain('printed system-map command');
    expect(prompt).toContain('Do not use rg');
    expect(prompt).toContain('Never restart a running command');
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

  it('supports direct graph navigation without requiring anchor discovery', () => {
    const prompt = directGraphTreatmentPrompt('How does the path work?');

    expect(prompt).toContain('read the scip-explore and scip-query SKILL.md instruction files once');
    expect(prompt).toContain('scip-explore defines the investigation purpose, evidence ledger, and stopping rule');
    expect(prompt).toContain('scip-query defines command and evidence semantics');
    expect(prompt).toContain('There is no fixed semantic-query allowance');
    expect(prompt).toContain('a material claim remains unresolved and an exact relevant recovery path is available');
    expect(prompt).toContain("a tool packet's completion as completion of the user's task");
    expect(prompt).not.toContain('The normal exploration budget is');
    expect(prompt).not.toContain("scip-query evidence --symbol '<first>'");
    expect(prompt).not.toContain("Run the chosen set's printed system-map command unchanged");
  });
});
