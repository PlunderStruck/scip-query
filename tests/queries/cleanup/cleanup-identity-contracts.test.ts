import { duplicateBodies } from '../../../src/queries/cleanup/duplicate-bodies.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SymbolInformation_Kind as Kind } from '@c4312/scip';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';
import { redundantReexports } from '../../../src/queries/cleanup/redundant-reexports.js';
import { similarSignatures } from '../../../src/queries/cleanup/similar-signatures.js';
import { unusedParams } from '../../../src/queries/cleanup/unused-params.js';

describe('cleanup command identity contracts', () => {
  it('compares the selected body when sibling functions share a source line', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-duplicate-same-line-'));
    const first = 'export function first() { return "alpha"; }';
    const second = 'export function second() { return "beta"; }';
    const other = 'export function other() { return "alpha"; }';
    try {
      writeFixtureFiles(root, { 'src/pair.ts': `${first} ${second}`, 'src/other.ts': other });
      const builder = evidenceFixtureDb(join(root, 'index.db'))
        .document(1, 'typescript', 'src/pair.ts')
        .document(2, 'typescript', 'src/other.ts');
      for (const [id, name, file, document, start, end] of [
        [1, 'first', 'pair.ts', 1, 0, first.length],
        [2, 'second', 'pair.ts', 1, first.length + 1, first.length + 1 + second.length],
        [3, 'other', 'other.ts', 2, 0, other.length],
      ] as const)
        builder
          .symbol(id, `scip-typescript npm fixture 1.0.0 src/\`${file}\`/${name}().`, name, Kind.Function)
          .definition(id, document, id, 0, start, 0, end);
      builder.write();
      const db = new ScipDatabase({ projectRoot: root, dbPath: join(root, 'index.db') });
      try {
        const groups = duplicateBodies(db, { minLoc: 1 });
        expect(groups).toHaveLength(1);
        expect(groups[0]?.functions.map((fn) => fn.shortName.split(':').at(-1)).sort()).toEqual(['first()', 'other()']);
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('checks parameter bindings on the declaration line and preserves implicit arguments usage', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-unused-binding-'));
    const source = [
      'export function sameLine(value: number) { console.log(value);',
      '}',
      'export function implicit(value: number) {',
      '  return arguments[0];',
      '}',
      'export function unused(value: number) {',
      '  return 1;',
      '}',
      'export function shadowed(value: number) {',
      '  const inner = (value: number) => value;',
      '  return inner(1);',
      '}',
    ];
    try {
      writeFixtureFiles(root, { 'src/functions.ts': source });
      const builder = evidenceFixtureDb(join(root, 'index.db')).document(1, 'typescript', 'src/functions.ts');
      for (const [id, name, start, end] of [
        [1, 'sameLine', 0, 1],
        [2, 'implicit', 2, 4],
        [3, 'unused', 5, 7],
        [4, 'shadowed', 8, 11],
      ] as const)
        builder
          .symbol(id, `scip-typescript npm fixture 1.0.0 src/\`functions.ts\`/${name}().`, name, Kind.Function)
          .definition(id, 1, id, start, 0, end, 1);
      builder.write();
      const db = new ScipDatabase({ projectRoot: root, dbPath: join(root, 'index.db') });
      try {
        expect(
          unusedParams(db)
            .map((row) => row.shortName.split(':').at(-1))
            .sort(),
        ).toEqual(['shadowed()', 'unused()']);
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('does not propose deleting an intermediary re-export used by another re-export', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-reexport-chain-'));
    const files = {
      'src/leaf.ts': 'export function leaf() {}\n',
      'src/middle.ts': "export { leaf } from './leaf';\n",
      'src/public.ts': "export { leaf } from './middle';\n",
      'src/use.ts': "import { leaf } from './public'; leaf();\n",
      'src/orphan.ts': "export { leaf } from './leaf';\n",
    };
    try {
      writeFixtureFiles(root, files);
      const builder = evidenceFixtureDb(join(root, 'index.db'));
      Object.keys(files).forEach((file, index) => builder.document(index + 1, 'typescript', file));
      builder.write();
      const db = new ScipDatabase({ projectRoot: root, dbPath: join(root, 'index.db') });
      try {
        expect(redundantReexports(db).map((row) => row.barrelFile)).toEqual(['src/orphan.ts']);
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps case-sensitive types and whitespace inside literal types distinct', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-signature-literals-'));
    const declarations = [
      'export function first(x: Token): void {}',
      'export function second(x: token): void {}',
      'export function spaced(x: "a b"): void {}',
      'export function joined(x: "ab"): void {}',
      'export function same(x: Token): void {}',
    ];
    try {
      writeFixtureFiles(root, { 'src/functions.ts': declarations.join('\n') });
      const builder = evidenceFixtureDb(join(root, 'index.db')).document(1, 'typescript', 'src/functions.ts');
      declarations.forEach((text, line) => {
        const name = /function (\w+)/.exec(text)![1]!;
        builder
          .symbol(line + 1, `scip-typescript npm fixture 1.0.0 src/\`functions.ts\`/${name}().`, name, Kind.Function)
          .definition(line + 1, 1, line + 1, line, 0, line, text.length);
      });
      builder.write();
      const db = new ScipDatabase({ projectRoot: root, dbPath: join(root, 'index.db') });
      try {
        const groups = similarSignatures(db, { semantic: false });
        expect(groups).toHaveLength(1);
        expect(groups[0]?.functions.map((fn) => fn.shortName.split(':').at(-1)).sort()).toEqual(['first()', 'same()']);
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
