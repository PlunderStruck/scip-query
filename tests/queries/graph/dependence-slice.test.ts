import { SymbolInformation_Kind } from '@c4312/scip';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dependenceSlice } from '../../../src/queries/graph/dependence-slice.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

function withSource(source: string[], run: (db: ScipDatabase) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'scip-variable-slice-'));
  const dbPath = join(root, 'index.db');
  writeFixtureFiles(root, { 'src/calculate.ts': source });
  evidenceFixtureDb(dbPath)
    .document(1, 'typescript', 'src/calculate.ts')
    .symbol(
      1,
      'scip-typescript npm fixture 1.0.0 src/`calculate.ts`/calculate().',
      'calculate',
      SymbolInformation_Kind.Function,
    )
    .definition(1, 1, 1, 0, 0, source.length - 1, 1)
    .chunk(1, 1, 0, source.length)
    .mention(1, 1, 1)
    .write();
  const db = new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') });
  try {
    run(db);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const REASSIGNMENT = [
  'export function calculate(input: number, discarded: number) {',
  '  let value = discarded;',
  '  value = input + 1;',
  '  const unrelated = discarded * 2;',
  '  return value;',
  '}',
];

describe('variable occurrence dependence slices', () => {
  it.each([
    'input && (value = input);',
    'input || (value = input);',
    'input ?? (value = input);',
    'input ? (value = input) : 0;',
  ])('preserves both reaching values across %s', (expression) => {
    withSource(
      [
        'export function calculate(input: number, fallback: number) {',
        '  let value = fallback;',
        `  ${expression}`,
        '  return value;',
        '}',
      ],
      (db) => {
        const result = dependenceSlice(db, 'src/calculate.ts:4', { variable: 'value' });
        expect(result.coverage.status).toBe('complete');
        expect(result.points).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: 'fallback', kind: 'parameter-definition' }),
            expect.objectContaining({ name: 'input', kind: 'parameter-definition' }),
          ]),
        );
      },
    );
  });

  it.each([
    { body: ['const alias = state;', 'alias.value = input;'], value: 'state.value', reason: 'Object alias' },
    {
      body: ['const holder = { ref: state };', 'holder.ref.value = input;'],
      value: 'state.value',
      reason: 'Object alias',
    },
    {
      body: ['const holder = { state };', 'holder.state.value = input;'],
      value: 'state.value',
      reason: 'Object alias',
    },
    { body: ['const holder = [state];', 'holder[0].value = input;'], value: 'state.value', reason: 'Object alias' },
    {
      body: ['const holder = ({ ref: state } as const);', 'holder.ref.value = input;'],
      value: 'state.value',
      reason: 'Object alias',
    },
    { body: ['let alias;', 'alias = state;', 'alias.value = input;'], value: 'state.value', reason: 'Object alias' },
    { body: ['let value = input;', 'const previous = value++;'], value: 'value', reason: 'Nested increment/decrement' },
    { body: ['let value = input;', 'const previous = ++value;'], value: 'value', reason: 'Nested increment/decrement' },
    { body: ['const value = input + ;'], value: 'value', reason: 'syntax error' },
  ])('discloses $reason rather than complete dependence coverage', ({ body, value, reason }) => {
    withSource(
      ['export function calculate(input: number, state: {value: number}) {', ...body, `return ${value};`, '}'],
      (db) => {
        const result = dependenceSlice(db, `src/calculate.ts:${body.length + 2}`, { variable: value });
        expect(result.coverage.status).not.toBe('complete');
        expect(result.coverage.model.unsupported.join(' ')).toContain(reason);
      },
    );
  });

  it.each(['delete state.value;', 'const removed = delete state.value;'])(
    'invalidates stale values at %s',
    (deletion) => {
      withSource(
        [
          'export function calculate(input: number, state: { value?: number }) {',
          'state.value = input;',
          deletion,
          'return state.value;',
          '}',
        ],
        (db) => {
          const result = dependenceSlice(db, 'src/calculate.ts:4', { variable: 'state.value' });
          expect(result.coverage.status).toBe('incomplete');
          expect(result.coverage.model.unsupported.join(' ')).toContain('Property deletion');
          expect(result.points.some((point) => point.name === 'input')).toBe(false);
        },
      );
    },
  );

  it('does not treat a fresh object containing scalar values as an object alias', () => {
    withSource(
      ['export function calculate(input: number) {', 'const holder = { input };', 'return holder;', '}'],
      (db) => {
        const result = dependenceSlice(db, 'src/calculate.ts:3', { variable: 'holder' });
        expect(result.coverage.status).toBe('complete');
        expect(result.points.some((point) => point.name === 'input' && point.kind === 'parameter-definition')).toBe(
          true,
        );
      },
    );
  });

  it('keeps cross-callable closure candidates outside the proved slice', () => {
    withSource(
      [
        'export function calculate(input: number) {',
        '  let value = input;',
        '  const read = () => value;',
        '  value = input + 1;',
        '  return read();',
        '}',
      ],
      (db) => {
        const result = dependenceSlice(db, 'src/calculate.ts:3', { variable: 'value' });
        expect(result.resolution).toBe('matched');
        expect(result.coverage.status).toBe('incomplete');
        expect(result.coverage.candidateEdges).toBeGreaterThan(0);
        expect(result.edges.every((edge) => edge.strength === 'exact')).toBe(true);
        expect(result.points.every((point) => point.callableId === result.candidates[0]!.callableId)).toBe(true);
      },
    );
  });

  it('discloses unsupported abrupt-finally sequencing in a selected variable slice', () => {
    withSource(
      [
        'export function calculate(input: number, state: { cleaned: boolean }) {',
        '  try {',
        '    return input;',
        '  } finally { state.cleaned = true; }',
        '}',
      ],
      (db) => {
        const result = dependenceSlice(db, 'src/calculate.ts:3', { variable: 'input' });
        expect(result.resolution).toBe('matched');
        expect(result.coverage.status).toBe('incomplete');
        expect(result.coverage.model.unsupported).toContain(
          'A finally block after return, break, or continue inside its try or catch is not sequenced in the local compiler CFG.',
        );
      },
    );
  });

  it('follows the reaching assignment and its RHS, excluding overwritten values and unrelated statements', () => {
    withSource(REASSIGNMENT, (db) => {
      const result = dependenceSlice(db, 'src/calculate.ts:5', { variable: 'value' });
      expect(result.resolution).toBe('matched');
      expect(result.coverage.status).toBe('complete');
      expect(result.points).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'input', kind: 'parameter-definition' }),
          expect.objectContaining({ name: 'input', kind: 'use', line: 2 }),
          expect.objectContaining({ name: 'value', kind: 'definition', line: 2 }),
        ]),
      );
      expect(result.points.some((point) => point.name === 'discarded' || point.name === 'unrelated')).toBe(false);
      expect(result.edges.map((edge) => edge.kind)).toEqual(
        expect.arrayContaining(['reaching-definition', 'value-source']),
      );
    });
  });

  it('keeps both reaching branch definitions and the condition that controls them', () => {
    withSource(
      [
        'export function calculate(left: number, right: number, flag: boolean) {',
        '  let value = left;',
        '  if (flag) { value = right; }',
        '  return value;',
        '}',
      ],
      (db) => {
        const result = dependenceSlice(db, 'src/calculate.ts:4', { variable: 'value' });
        expect(result.resolution).toBe('matched');
        expect(
          result.points
            .filter((point) => point.name === 'value' && point.kind === 'definition')
            .map((point) => point.line),
        ).toEqual([1, 2]);
        expect(result.points).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'flag', kind: 'use' })]));
        expect(result.edges.some((edge) => edge.kind === 'control-dependence')).toBe(true);
      },
    );
  });

  it('follows a selected input forward to the returned use without including sibling computations', () => {
    withSource(REASSIGNMENT, (db) => {
      const result = dependenceSlice(db, 'src/calculate.ts:1', { variable: 'input', direction: 'forward' });
      expect(result.points).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'value', kind: 'use', line: 4 })]),
      );
      expect(result.points.some((point) => point.name === 'unrelated')).toBe(false);
    });
  });

  it('requires an exact occurrence when the same variable is read twice on one line', () => {
    const source = ['export function calculate(value: number) {', '  return value + value;', '}'];
    withSource(source, (db) => {
      const ambiguous = dependenceSlice(db, 'src/calculate.ts:2', { variable: 'value' });
      expect(ambiguous).toMatchObject({
        resolution: 'ambiguous',
        points: [],
        edges: [],
        coverage: { status: 'incomplete' },
      });
      expect(ambiguous.candidates).toHaveLength(2);
      const selected = dependenceSlice(db, 'src/calculate.ts:2', {
        variable: 'value',
        column: source[1]!.lastIndexOf('value') + 1,
      });
      expect(selected.resolution).toBe('matched');
      expect(selected.candidates).toHaveLength(1);
    });
  });

  it('reports output and depth bounds without claiming a complete slice', () => {
    withSource(REASSIGNMENT, (db) => {
      const bounded = dependenceSlice(db, 'src/calculate.ts:5', { variable: 'value', maxEdges: 0 });
      expect(bounded.edges).toEqual([]);
      expect(bounded.points).toHaveLength(1);
      expect(bounded.coverage).toMatchObject({ status: 'bounded', depthLimited: false });
      expect(bounded.coverage.omittedEdges).toBeGreaterThan(0);
      const shallow = dependenceSlice(db, 'src/calculate.ts:5', { variable: 'value', maxDepth: 0 });
      expect(shallow.coverage).toMatchObject({ status: 'bounded', depthLimited: true });
    });
  });

  it('rejects symbol summaries and reports missing criteria explicitly', () => {
    withSource(REASSIGNMENT, (db) => {
      expect(() => dependenceSlice(db, 'calculate')).toThrow('exact file:line');
      expect(dependenceSlice(db, 'src/calculate.ts:5', { variable: 'missing' }).resolution).toBe('missing');
      expect(() => dependenceSlice(db, 'src/calculate.ts:5', { column: 0 })).toThrow('column');
      expect(dependenceSlice(db, 'src/calculate.py:1').resolution).toBe('unsupported');
    });
  });
});
