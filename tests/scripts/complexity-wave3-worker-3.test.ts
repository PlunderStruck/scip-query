import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Execute only selected function declarations; never launch either benchmark script.
function scriptFunctions(path: string, names: string[], globals: Record<string, unknown> = {}) {
  const source = ts.createSourceFile(
    path,
    readFileSync(resolve(path), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const declarations = source.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ''),
  );
  expect(declarations).toHaveLength(names.length);
  const context = createContext({ Error, ...globals });
  runInContext(declarations.map((node) => node.getText(source)).join('\n'), context);
  return context;
}

function leafFixture(failIteration = false, dirtyCleanup = false) {
  const original = Buffer.from('original');
  let disk = original;
  let statuses = 0;
  let shadowRuns = 0;
  const effects: string[] = [];
  const records: Record<string, unknown>[] = [];
  const context = scriptFunctions(
    'scripts/affected-set-shadow-contract.mjs',
    ['runLeafCorpus', 'measureLeafCorpus', 'repairLeafCorpus', 'throwLeafCorpusErrors'],
    {
      args: { editFile: 'leaf.ts', label: 'fixture', iterations: 2 },
      runId: 'unit',
      records,
      activeProjectRoot: undefined,
      requiredProjectRoot: () => '/fixture',
      resolve,
      requiredArg: (value: string) => value,
      existsSync: () => true,
      gitStatus: () => (statuses++ > 0 && dirtyCleanup ? ' M leaf.ts' : ''),
      readFileSync: () => disk,
      appendText: (value: Buffer, text: string) => Buffer.concat([value, Buffer.from(text)]),
      writeFileSync: (_path: string, value: Buffer) => {
        disk = value;
        effects.push(value.equals(original) ? 'restore' : 'mutate');
      },
      runCli: (_root: string, args: string[]) => {
        effects.push(args[0]!);
        return { exitCode: dirtyCleanup && shadowRuns > 1 ? 1 : 0, stderr: 'repair error' };
      },
      assertCommand: () => undefined,
      reindexWithShadow: () => {
        shadowRuns++;
        if (failIteration && shadowRuns === 2) throw new Error('iteration failed');
        return { shadow: {} };
      },
      verifyShadow: () => undefined,
      baseRecord: (record: unknown) => record,
      gitCommit: () => 'commit',
      measurementFields: () => ({ measured: true }),
      leafSummary: () => ({ accepted: true }),
    },
  );
  return { context, records, effects, disk: () => disk, original };
}

describe('wave3 worker3 script contracts', () => {
  it('preserves alternating leaf writes, measurement order, and final repair', async () => {
    const fixture = leafFixture();
    await fixture.context.runLeafCorpus();
    expect(fixture.records.map((record) => [record.mode, record.direction])).toEqual([
      ['leaf', 'restore'],
      ['leaf', 'apply'],
      ['leaf-summary', undefined],
    ]);
    expect(fixture.effects).toEqual([
      'watch',
      'reindex',
      'mutate',
      'restore',
      'mutate',
      'restore',
      'reindex',
      'watch',
      'reindex',
    ]);
    expect(fixture.disk()).toEqual(fixture.original);
    expect(fixture.context.activeProjectRoot).toBeUndefined();
  });

  it('keeps the iteration error and gives dirty Git state precedence over a repair error', async () => {
    const fixture = leafFixture(true, true);
    await expect(fixture.context.runLeafCorpus()).rejects.toThrow(
      'iteration failed; cleanup also failed: corpus Git state changed:',
    );
    expect(fixture.records).toEqual([]);
    expect(fixture.disk()).toEqual(fixture.original);
    expect(fixture.effects.slice(-2)).toEqual(['watch', 'reindex']);
    expect(fixture.context.activeProjectRoot).toBeUndefined();
  });

  it('keeps calibration field order, graph precedence, and the exact metric whitelist', () => {
    const context = scriptFunctions('scripts/semantic-command-calibration.mjs', [
      'summarizeParsedJson',
      'summarizeObjectMetrics',
      'summarizeObjectStatus',
    ]);
    const result = context.summarizeParsedJson({
      command: 'health',
      result: {
        overview: { budget: { semanticEnrichment: false } },
        score: 0,
        riskScore: 3,
        hygieneScore: 5,
        findings: new Array(3),
        symbols: [],
        files: ['a'],
        imports: [],
        callers: ['ignored'],
        callGraph: { callers: [], callees: ['a', 'b'] },
        matched: false,
        totalMatches: 0,
        exitCode: 2,
        unexpected: 42,
      },
    });
    expect(Object.keys(result)).toEqual([
      'command',
      'evidence',
      'semanticEnrichment',
      'resultKind',
      'resultKeys',
      'healthScore',
      'riskScore',
      'hygieneScore',
      'findings',
      'symbols',
      'files',
      'imports',
      'callers',
      'callees',
      'matched',
      'totalMatches',
      'innerExitCode',
    ]);
    expect(result).toMatchObject({
      semanticEnrichment: false,
      healthScore: 0,
      findings: 3,
      callers: 0,
      callees: 2,
      matched: false,
      totalMatches: 0,
      innerExitCode: 2,
    });
    expect(result).not.toHaveProperty('unexpected');
    expect(
      context.summarizeParsedJson({
        analysisBudget: { semanticEnrichment: true },
        result: { score: '3', findings: {}, callGraph: null, callers: ['a'] },
      }),
    ).toMatchObject({ semanticEnrichment: true, callers: 1 });
    expect(context.summarizeParsedJson(new Array(4))).toMatchObject({ resultKind: 'array', resultCount: 4 });
  });
});
