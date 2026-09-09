import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sourceStateTemporalAnalysis } from '../../../src/source/facts/state-temporal-analysis.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

function analyze(source: string[], file = 'flow.ts', language = 'typescript', range = [0, source.length - 1]) {
  const root = mkdtempSync(join(tmpdir(), 'state-temporal-accuracy-'));
  const dbPath = join(root, 'index.db');
  try {
    writeFixtureFiles(root, { [file]: source });
    evidenceFixtureDb(dbPath).document(1, language, file).write();
    const db = new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') });
    try {
      const result = sourceStateTemporalAnalysis(db, file, range[0]!, range[1]!);
      expect(result).not.toBeNull();
      return result!;
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('state and temporal fact accuracy', () => {
  it('resolves captures despite a same-name type property and an unrelated block binding', () => {
    const result = analyze(
      [
        'function factory(value: number) {',
        '  return function inner(state: any, ignored: { value: string }) {',
        '    { const value = 2; state.value = value; }',
        '    state.value = value;',
        '  };',
        '}',
      ],
      'flow.ts',
      'typescript',
      [1, 4],
    );
    expect(result.mutations.map((mutation) => mutation.dataSubtype)).toEqual([
      'value-to-state',
      'captured-value-to-state',
    ]);
  });

  it('distinguishes interpolated templates from constant strings', () => {
    const result = analyze([
      'function update(state: any, input: string) {',
      ' state.a = `fixed`; state.b = `prefix ${input}`;',
      '}',
    ]);
    expect(result.mutations.map((mutation) => mutation.dataSubtype)).toEqual([
      'constant-to-state',
      'expression-to-state',
    ]);
  });

  it('keeps a direct await continuation while excluding return and throw continuations', () => {
    const result = analyze([
      'async function update(state: any) {',
      ' await work();',
      ' state.a = 1;',
      ' return await work();',
      ' state.b = 2;',
      '}',
    ]);
    const before = result.temporal.filter((fact) => fact.subtype === 'await-completion-before');
    expect(before.map((fact) => fact.to.label)).toEqual(['state.a = 1;']);
  });

  it('keeps distinct computed access paths and Unicode-prefixed shadowed declarations', () => {
    const result = analyze([
      'function update(state: any) {',
      ' const emoji = "😀"; state["a"] = 1; state["b"] = 2;',
      ' { const state: any = {}; state["a"] = 3; }',
      ' state["a"] = 4;',
      '}',
    ]);
    const keys = result.mutations.map((mutation) => mutation.resource.resourceKey);
    expect(keys[0]).toBe(keys[3]);
    expect(new Set(keys).size).toBe(3);
  });

  it.each([
    [
      'flow.rs',
      'rust',
      ['fn update(state: &mut State) {', ' state.value = 1;', ' let deferred = || { state.hidden = 2; };', '}'],
    ],
    [
      'flow.py',
      'python',
      ['def update(state):', '    state.value = 1', '    def deferred():', '        state.hidden = 2'],
    ],
    [
      'flow.js',
      'javascript',
      ['function update(state) {', ' state.value = 1;', ' const deferred = () => { state.hidden = 2; };', '}'],
    ],
  ])('keeps deferred mutations out of the enclosing callable in %s', (file, language, source) => {
    const result = analyze(source, file, language);
    expect(result.mutations.map((mutation) => mutation.resource.label)).toEqual(['state.value']);
  });
});
