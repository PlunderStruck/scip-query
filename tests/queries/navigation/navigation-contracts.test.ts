import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { SymbolInformation_Kind as Kind } from '@c4312/scip';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';
import { outline } from '../../../src/queries/navigation/outline.js';
import { methods } from '../../../src/queries/navigation/methods.js';
import { members } from '../../../src/queries/navigation/members.js';
import { importedBy, imports } from '../../../src/queries/navigation/imports.js';
import { hierarchy } from '../../../src/queries/navigation/hierarchy.js';
import { callGraph } from '../../../src/queries/navigation/call-graph.js';
import { refs } from '../../../src/queries/navigation/refs.js';
import { possibleImpactClosure } from '../../../src/queries/graph/affected.js';
const prefix = 'scip-typescript npm fixture 1.0.0 ';

function withRoot(run: (root: string, dbPath: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'scip-navigation-contract-'));
  try {
    run(root, join(root, 'index.db'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function useDb(root: string, dbPath: string, run: (db: ScipDatabase) => void): void {
  const db = new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') });
  try {
    run(db);
  } finally {
    db.close();
  }
}
describe('navigation command referents', () => {
  it('attributes a type reference to its actual owner, never the first function in the file', () =>
    withRoot((root, path) => {
      const target = prefix + 'src/`type.ts`/Target#';
      const unrelated = prefix + 'src/`use.ts`/unrelated().';
      const usesType = prefix + 'src/`use.ts`/usesType().';
      const source = [
        'export function unrelated() { return 1; }',
        'export function usesType(value: Target) { return value; }',
      ];
      writeFixtureFiles(root, { 'src/type.ts': 'export interface Target { value: number }', 'src/use.ts': source });
      evidenceFixtureDb(path)
        .document(1, 'typescript', 'src/type.ts')
        .document(2, 'typescript', 'src/use.ts')
        .symbol(1, target, 'Target', Kind.Interface)
        .definition(1, 1, 1, 0, 0, 0, 41)
        .symbol(2, unrelated, 'unrelated', Kind.Function)
        .definition(2, 2, 2, 0, 0, 0, source[0]!.length)
        .symbol(3, usesType, 'usesType', Kind.Function)
        .definition(3, 2, 3, 1, 0, 1, source[1]!.length)
        .chunk(1, 1, 0, 0)
        .mention(1, 1, 1)
        .chunk(2, 2, 0, 1)
        .mention(2, 1, 0)
        .mention(2, 2, 1)
        .mention(2, 3, 1)
        .occurrence(2, target, 1, 0, source[1]!.indexOf('Target'), source[1]!.indexOf('Target') + 6)
        .write();
      useDb(root, path, (db) => {
        expect(possibleImpactClosure(db, target).rows.map((row) => row.symbol)).toEqual([usesType]);
      });
    }));
  it('limits methods to the exact owner, excluding same-name substrings and functions', () =>
    withRoot((root, path) => {
      writeFixtureFiles(root, {
        'src/models.ts': [
          'export class Client { own() {} }',
          'export class OtherClient { foreign() {} }',
          'export function useClient() {}',
        ],
      });
      const client = prefix + 'src/`models.ts`/Client#';
      const other = prefix + 'src/`models.ts`/OtherClient#';
      evidenceFixtureDb(path)
        .document(1, 'typescript', 'src/models.ts')
        .chunk(1, 1, 0, 2)
        .symbol(1, client, 'Client', Kind.Class)
        .definition(1, 1, 1, 0, 0, 0, 31)
        .mention(1, 1, 1)
        .symbol(2, client + 'own().', 'own', Kind.Method)
        .definition(2, 1, 2, 0, 22, 0, 29)
        .mention(1, 2, 1)
        .symbol(3, other, 'OtherClient', Kind.Class)
        .definition(3, 1, 3, 1, 0, 1, 41)
        .mention(1, 3, 1)
        .symbol(4, other + 'foreign().', 'foreign', Kind.Method)
        .definition(4, 1, 4, 1, 27, 1, 38)
        .mention(1, 4, 1)
        .symbol(5, prefix + 'src/`models.ts`/useClient().', 'useClient', Kind.Function)
        .definition(5, 1, 5, 2, 0, 2, 30)
        .mention(1, 5, 1)
        .write();
      useDb(root, path, (db) => {
        expect(methods(db, client).map((row) => row.name)).toEqual(['own']);
        expect(methods(db, other).map((row) => row.name)).toEqual(['foreign']);
        expect(members(db, client).map((row) => row.symbol)).toEqual([client + 'own().']);
        expect(() => methods(db, 'missingOwner')).toThrow(/matched/i);
      });
    }));
  it('resolves importers by exact symbol identity and excludes side effects from unknown symbol queries', () =>
    withRoot((root, path) => {
      const run = prefix + 'src/`a.ts`/run().',
        runAgain = prefix + 'src/`a.ts`/runAgain().';
      writeFixtureFiles(root, {
        'src/a.ts': ['export function run() {}', 'export function runAgain() {}'],
        'src/b.ts': "import { runAgain } from './a';\nrunAgain();",
        'src/c.ts': "import './a';",
      });
      evidenceFixtureDb(path)
        .document(1, 'typescript', 'src/a.ts')
        .document(2, 'typescript', 'src/b.ts')
        .document(3, 'typescript', 'src/c.ts')
        .chunk(1, 1, 0, 1)
        .chunk(2, 2, 0, 1)
        .chunk(3, 3, 0, 0)
        .symbol(1, run, 'run', Kind.Function)
        .definition(1, 1, 1, 0, 0, 0, 25)
        .mention(1, 1, 1)
        .symbol(2, runAgain, 'runAgain', Kind.Function)
        .definition(2, 1, 2, 1, 0, 1, 30)
        .mention(1, 2, 1)
        .mention(2, 2, 2)
        .write();
      useDb(root, path, (db) => {
        expect(importedBy(db, 'run')).toEqual([]);
        expect(importedBy(db, 'runAgain').map((row) => row.fromFile)).toEqual(['src/b.ts']);
        expect(importedBy(db, runAgain).map((row) => row.symbol)).toEqual([runAgain]);
        expect(importedBy(db, 'never_exists')).toEqual([]);
      });
    }));
  it('combines partial indexed imports with source bindings and retains every observed importer', () =>
    withRoot((root, path) => {
      const alpha = prefix + 'src/`a.ts`/alpha().';
      const beta = prefix + 'src/`a.ts`/beta().';
      writeFixtureFiles(root, {
        'src/a.ts': ['export function alpha() {}', 'export function beta() {}'],
        'src/b.ts': "import { alpha, beta as second } from './a';\nalpha(); second();",
        'src/c.ts': "import { alpha as first } from './a';\nfirst();",
        'src/d.ts': 'export function alpha() {}',
      });
      evidenceFixtureDb(path)
        .document(1, 'typescript', 'src/a.ts')
        .document(2, 'typescript', 'src/b.ts')
        .document(3, 'typescript', 'src/c.ts')
        .document(4, 'typescript', 'src/d.ts')
        .chunk(1, 1, 0, 1)
        .chunk(2, 2, 0, 1)
        .chunk(3, 3, 0, 1)
        .chunk(4, 4, 0, 0)
        .symbol(1, alpha, 'alpha', Kind.Function)
        .definition(1, 1, 1, 0, 0, 0, 26)
        .mention(1, 1, 1)
        .symbol(2, beta, 'beta', Kind.Function)
        .definition(2, 1, 2, 1, 0, 1, 25)
        .mention(1, 2, 1)
        .symbol(3, prefix + 'src/`d.ts`/alpha().', 'alpha', Kind.Function)
        .definition(3, 4, 3, 0, 0, 0, 26)
        .mention(4, 3, 1)
        .mention(2, 1, 2)
        .write();
      useDb(root, path, (db) => {
        const rows = imports(db, 'src/b.ts', { semantic: false });
        expect(rows).toHaveLength(2);
        expect(rows.some((row) => row.shortName === 'beta as second')).toBe(true);
        expect(importedBy(db, alpha).map((row) => row.fromFile)).toEqual(['src/b.ts', 'src/c.ts']);
        expect(() => importedBy(db, 'alpha')).toThrow(/ambiguous/i);
      });
    }));
  it('matches default and renamed exports to their local declarations', () =>
    withRoot((root, path) => {
      const run = prefix + 'src/`a.ts`/run().';
      writeFixtureFiles(root, {
        'src/a.ts': ['function run() {}', 'export { run as renamed };', 'export default run;'],
        'src/default.ts': "import start from './a';\nstart();",
        'src/named.ts': "import { renamed as start } from './a';\nstart();",
        'src/unrelated.ts': "import { notRun } from './a';",
      });
      evidenceFixtureDb(path)
        .document(1, 'typescript', 'src/a.ts')
        .document(2, 'typescript', 'src/default.ts')
        .document(3, 'typescript', 'src/named.ts')
        .document(4, 'typescript', 'src/unrelated.ts')
        .symbol(1, run, 'run', Kind.Function)
        .definition(1, 1, 1, 0, 0, 0, 17)
        .chunk(1, 1, 0, 2)
        .mention(1, 1, 1)
        .write();
      useDb(root, path, (db) => {
        expect(importedBy(db, run).map((row) => row.fromFile)).toEqual(['src/default.ts', 'src/named.ts']);
      });
    }));
  it('rejects cyclic compiler ownership rather than losing the entire outline', () =>
    withRoot((root, path) => {
      const first = prefix + 'src/`owners.ts`/First#';
      const second = prefix + 'src/`owners.ts`/Second#';
      writeFixtureFiles(root, { 'src/owners.ts': ['class First {}', 'class Second {}'] });
      evidenceFixtureDb(path)
        .document(1, 'typescript', 'src/owners.ts')
        .symbol(1, first, 'First', Kind.Class)
        .definition(1, 1, 1, 0, 0, 0, 14)
        .symbol(2, second, 'Second', Kind.Class)
        .definition(2, 1, 2, 1, 0, 1, 15)
        .write();
      const sql = new Database(path);
      sql.prepare('UPDATE global_symbols SET enclosing_symbol=? WHERE symbol=?').run(second, first);
      sql.prepare('UPDATE global_symbols SET enclosing_symbol=? WHERE symbol=?').run(first, second);
      sql.close();
      useDb(root, path, (db) => expect(() => outline(db, 'src/owners.ts')).toThrow(/cyclic.*ownership/i));
    }));
  it('does not turn Ruby instance-variable text in another class into a reference', () =>
    withRoot((root, path) => {
      const symbol = 'scip-ruby gem fixture 1.0.0 Billing/Code#';
      writeFixtureFiles(root, {
        'billing.rb': 'class Billing\n  class Code\n  end\nend',
        'other.rb': 'class Other\n  def update\n    @code = 1\n  end\nend',
      });
      evidenceFixtureDb(path)
        .document(1, 'ruby', 'billing.rb')
        .document(2, 'ruby', 'other.rb')
        .chunk(1, 1, 0, 3)
        .chunk(2, 2, 0, 4)
        .symbol(1, symbol, 'Code', Kind.Class)
        .definition(1, 1, 1, 1, 2, 2, 5)
        .mention(1, 1, 1)
        .write();
      useDb(root, path, (db) =>
        expect(refs(db, symbol, { semantic: false }).map((row) => row.relativePath)).not.toContain('other.rb'),
      );
    }));
  it('returns every indexed owner beyond depth twenty and stops on a corrupt cycle', () =>
    withRoot((root, path) => {
      writeFixtureFiles(root, { 'src/owners.ts': 'export const owner = 1;' });
      const builder = evidenceFixtureDb(path).document(1, 'typescript', 'src/owners.ts').chunk(1, 1, 0, 0);
      const symbols = Array.from({ length: 24 }, (_, i) => prefix + `src/\`owners.ts\`/Owner${i}#`);
      symbols.forEach((symbol, i) =>
        builder
          .symbol(i + 1, symbol, `Owner${i}`, Kind.Class)
          .definition(i + 1, 1, i + 1, 0, 0, 0, 22)
          .mention(1, i + 1, 1),
      );
      builder.write();
      const sql = new Database(path);
      symbols.forEach((symbol, i) => {
        if (i > 0)
          sql.prepare('UPDATE global_symbols SET enclosing_symbol=? WHERE symbol=?').run(symbols[i - 1], symbol);
      });
      sql.close();
      useDb(root, path, (db) =>
        expect(hierarchy(db, symbols[23]!).map((row) => row.symbol)).toEqual([...symbols].reverse()),
      );
      const cyclic = new Database(path);
      cyclic.prepare('UPDATE global_symbols SET enclosing_symbol=? WHERE symbol=?').run(symbols[23], symbols[0]);
      cyclic.close();
      useDb(root, path, (db) => expect(hierarchy(db, symbols[23]!)).toHaveLength(24));
    }));
  it('does not silently drop the fifty-first call target', () =>
    withRoot((root, path) => {
      const names = Array.from({ length: 55 }, (_, i) => `leaf${i}`),
        rootSymbol = prefix + 'src/`calls.ts`/root().';
      const lines = [
        'export function root() {',
        ...names.map((name) => `  ${name}();`),
        '}',
        ...names.map((name) => `function ${name}() {}`),
      ];
      writeFixtureFiles(root, { 'src/calls.ts': lines });
      const builder = evidenceFixtureDb(path)
        .document(1, 'typescript', 'src/calls.ts')
        .chunk(1, 1, 0, lines.length - 1)
        .symbol(1, rootSymbol, 'root', Kind.Function)
        .definition(1, 1, 1, 0, 0, 56, 1)
        .mention(1, 1, 1);
      names.forEach((name, i) =>
        builder
          .symbol(i + 2, prefix + `src/\`calls.ts\`/${name}().`, name, Kind.Function)
          .definition(i + 2, 1, i + 2, 57 + i, 0, 57 + i, 24)
          .mention(1, i + 2, 1)
          .occurrence(1, prefix + `src/\`calls.ts\`/${name}().`, i + 1, 0, 2, 2 + name.length),
      );
      builder.write();
      useDb(root, path, (db) => {
        expect(callGraph(db, rootSymbol, { semantic: false })?.callees).toHaveLength(55);
        expect(
          callGraph(db, prefix + 'src/`calls.ts`/leaf54().', { semantic: false })?.callers.map((row) => row.symbol),
        ).toEqual([rootSymbol]);
        expect(callGraph(db, 'never_exists', { semantic: false })).toBeNull();
      });
    }));
});
