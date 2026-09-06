import { SymbolInformation_Kind } from '@c4312/scip';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sliceCohesion } from '../../../src/queries/quality/slice-cohesion.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

describe('slice cohesion coverage boundary', () => {
  it('does not upgrade unknown closure invocation order to complete coverage', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-cohesion-closure-'));
    const file = 'src/calculate.ts';
    const source = [
      'export function calculate(a: number, b: number) {',
      '  let value = a;',
      '  const read = () => value;',
      '  value = b;',
      '  const left = read();',
      '  const right = a + 1;',
      '  return { left, right };',
      '}',
    ];
    try {
      writeFixtureFiles(root, { [file]: source });
      evidenceFixtureDb(join(root, 'index.db'))
        .document(1, 'typescript', file)
        .symbol(
          1,
          'scip-typescript npm fixture 1.0.0 src/`calculate.ts`/calculate().',
          'calculate',
          SymbolInformation_Kind.Function,
        )
        .definition(1, 1, 1, 0, 0, source.length - 1, 1)
        .write();
      const db = new ScipDatabase({ projectRoot: root, dbPath: join(root, 'index.db') });
      try {
        const [result] = sliceCohesion(db, { symbol: 'calculate', minStatements: 1, minClusterUnits: 1 });
        expect(result?.coverage.unsupported.join(' ')).toContain('invocation order');
        expect(result?.coverage.status).toBe('partial');
        expect(result?.actionTier).toBe('support');
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it.each(['return { left, right };', 'break;', 'continue;'])(
    'withholds an extraction signal when finally follows %s',
    (completion) => {
      const root = mkdtempSync(join(tmpdir(), 'scip-cohesion-finally-'));
      const file = 'src/calculate.ts';
      const source = [
        'export function calculate(a: number, b: number, stop: boolean, state: { cleaned: number }) {',
        '  const a1 = a + 1;',
        '  const a2 = a1 * 2;',
        '  const a3 = a2 + 3;',
        '  const left = a3 * 4;',
        '  const b1 = b + 1;',
        '  const b2 = b1 * 2;',
        '  const b3 = b2 + 3;',
        '  const right = b3 * 4;',
        '  for (let i = 0; i < 2; i++) {',
        '    try {',
        `      if (stop) ${completion}`,
        '    } finally {',
        '      state.cleaned++;',
        '    }',
        '  }',
        '  return { left, right };',
        '}',
      ];
      const dbPath = join(root, 'index.db');
      writeFixtureFiles(root, { [file]: source });
      evidenceFixtureDb(dbPath)
        .document(1, 'typescript', file)
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
        const [result] = sliceCohesion(db, { symbol: 'calculate', minStatements: 1, minClusterUnits: 1 });
        expect(result).toMatchObject({ actionTier: 'support', coverage: { status: 'partial' } });
        expect(result!.coverage.unsupported).toContain(
          'A finally block after return, break, or continue inside its try or catch is not sequenced in the local compiler CFG.',
        );
      } finally {
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
