import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  createTypeScriptDocumentEmitter,
  loadTypeScriptDocumentRuntime,
} from '../../src/reindex/typescript-document-emitter.js';
import { cleanOracle } from '../fixtures/typescript-oracle.js';

const cases = [
  ['type literal', 'export type Note = { summary: string }; export const note: Note = { summary: "one" };'],
  ['inferred property', 'export const note = { summary: "one" };'],
  ['repeated property', 'const other = { summary: "two" }; export const note = { summary: "one" };'],
  ['shorthand property', 'const summary = "one"; export const note = { summary };'],
] as const;

test.each(
  cases.flatMap(([name, source]) => [
    [name, source],
    [name, 'const unicode = "🐈"; ' + source],
  ]),
)('%s identities join definitions to cold and warm subset references', (name, source) => {
  const loaded = loadTypeScriptDocumentRuntime();
  expect(loaded.available).toBe(true);
  if (!loaded.available) return;
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'scip-query-numbering-')));
  const consumer =
    'import { note } from "./z-owner"; function warm(input: number) { const local = input + 1; return local; } export const selected = note.summary;';
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'numbering-fixture', version: '1.0.0' }));
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { noLib: true, types: [], strict: true }, include: ['*.ts'] }),
    );
    writeFileSync(join(root, 'z-owner.ts'), source);
    writeFileSync(join(root, 'a-consumer.ts'), consumer);
    const oracle = cleanOracle(root, loaded.runtime);
    const owner = loaded.runtime.Document.deserializeBinary(oracle.get('z-owner.ts')!);
    // These expectations come from known declaration positions in the fixture,
    // independently of the adapter. No ordinal stripping or identity rewriting.
    const suffix =
      name === 'type literal'
        ? `typeLiteral$${source.indexOf('{')}:summary.`
        : `summary$${source.lastIndexOf('summary')}:`;
    const definitions = owner.occurrences.filter((o) => (o.symbol_roles & 1) === 1 && o.symbol.endsWith(suffix));
    expect(definitions).toHaveLength(1);
    const expectedSymbol = definitions[0]!.symbol;
    for (const warm of [false, true]) {
      const created = createTypeScriptDocumentEmitter({
        workspaceRoot: root,
        tsconfigPath: 'tsconfig.json',
        runtime: loaded.runtime,
      });
      expect(created.available).toBe(true);
      if (!created.available) continue;
      if (warm) created.emitter.initialize();
      const result = created.emitter.advance({ modifiedFiles: [], affectedFiles: ['a-consumer.ts'] });
      expect(result.fragments).toHaveLength(1);
      const fragment = result.fragments[0]!;
      expect(Buffer.from(fragment.bytes!)).toEqual(oracle.get('a-consumer.ts'));
      const document = loaded.runtime.Document.deserializeBinary(fragment.bytes!);
      expect(document.occurrences).toContainEqual(
        expect.objectContaining({
          symbol: expectedSymbol,
          symbol_roles: 0,
          range: [0, consumer.lastIndexOf('summary'), consumer.lastIndexOf('summary') + 7],
        }),
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
