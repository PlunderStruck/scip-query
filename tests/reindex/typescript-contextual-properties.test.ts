import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  createTypeScriptDocumentEmitter,
  loadTypeScriptDocumentRuntime,
} from '../../src/reindex/typescript-document-emitter.js';

test('inferred generic object keys define their own properties instead of borrowing another value declaration', () => {
  const loaded = loadTypeScriptDocumentRuntime();
  if (!loaded.available) throw new Error(loaded.reason);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'scip-contextual-properties-')));
  const source = [
    'declare function each<T>(cases: readonly T[]): void;',
    'export const unrelated = { title: "unrelated" };',
    'each([{ title: "case" }, { instructions: "case" }]);',
    'interface Contract { title: string }',
    'export const declared: Contract = { title: "declared" };',
  ].join('\n');
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'contextual-properties', version: '1.0.0' }));
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true }, files: ['a.ts'] }));
    writeFileSync(join(root, 'a.ts'), source);
    const created = createTypeScriptDocumentEmitter({ workspaceRoot: root, tsconfigPath: 'tsconfig.json' });
    if (!created.available) throw new Error(created.reason);
    const result = created.emitter.initialize();
    const document = loaded.runtime.Document.deserializeBinary(result.fragments[0]!.bytes!);
    const title = document.occurrences.filter((o) => o.range[0] === 2 && o.range[1] === 8);
    expect(title).toContainEqual(
      expect.objectContaining({
        symbol_roles: 1,
        symbol: expect.stringContaining(`/title$${source.indexOf('title: "case"')}:`),
      }),
    );
    expect(title.filter((o) => !(o.symbol_roles & 1))).toEqual([]);
    expect(document.occurrences).toContainEqual(
      expect.objectContaining({
        range: [4, 36, 41],
        symbol_roles: 0,
        symbol: expect.stringContaining('/Contract#title.'),
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
