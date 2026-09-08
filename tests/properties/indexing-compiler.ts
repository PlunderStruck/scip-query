import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import fc from 'fast-check';
import { it } from 'vitest';
import {
  createTypeScriptDocumentEmitter,
  loadTypeScriptDocumentRuntime,
} from '../../src/reindex/typescript-document-emitter.js';
import { cleanOracle } from '../fixtures/typescript-oracle.js';
import { checkProperty, PROPERTY_TIMEOUT } from './support.js';

function writeConsumer(root: string, files: ReadonlySet<number>): void {
  const ids = [...files].sort();
  const imports = ids.map((id) => `import { value${id} as alias${id} } from './f${id}.js';`);
  writeFileSync(
    join(root, 'entry.ts'),
    `${imports.join('\n')}\nexport const result = ${ids.map((id) => `alias${id}(2)`).join(' + ') || '0'};\n`,
  );
}

it(
  'indexing: retained compiler documents match a fresh external compiler after generated add/edit/delete sequences',
  async () => {
    const loaded = loadTypeScriptDocumentRuntime();
    assert.ok(loaded.available, loaded.available ? undefined : loaded.reason);
    await checkProperty(
      'indexing',
      'incremental-versus-external-compiler',
      fc.asyncProperty(
        fc.array(
          fc.record({
            file: fc.integer({ min: 0, max: 3 }),
            value: fc.option(fc.integer({ min: -100, max: 100 }), { nil: null }),
            branch: fc.boolean(),
          }),
          { minLength: 2, maxLength: 5 },
        ),
        async (steps) => {
          const root = realpathSync(mkdtempSync(join(tmpdir(), 'scip-query-property-compiler-')));
          try {
            writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'property-fixture', version: '1.0.0' }));
            writeFileSync(
              join(root, 'tsconfig.json'),
              JSON.stringify({
                compilerOptions: {
                  target: 'ES2022',
                  module: 'ESNext',
                  moduleResolution: 'Bundler',
                  strict: true,
                  types: [],
                  noLib: true,
                },
                include: ['*.ts'],
              }),
            );
            writeFileSync(join(root, 'f0.ts'), 'export function value0(input: number) { return input; }\n');
            const files = new Set([0]);
            writeConsumer(root, files);
            const created = createTypeScriptDocumentEmitter({
              workspaceRoot: root,
              tsconfigPath: 'tsconfig.json',
              projectRoot: '.',
              runtime: loaded.runtime,
            });
            assert.ok(created.available, created.available ? undefined : created.reason);
            const retained = new Map(
              created.emitter
                .initialize()
                .fragments.map((fragment) => [fragment.relativePath, Buffer.from(fragment.bytes ?? [])]),
            );
            for (const step of steps) {
              await setImmediate();
              const file = `f${step.file}.ts`;
              if (step.value === null) {
                rmSync(join(root, file), { force: true });
                files.delete(step.file);
                retained.delete(file);
              } else {
                files.add(step.file);
                writeFileSync(
                  join(root, file),
                  `export function value${step.file}(input: number) { ${step.branch ? `if (input > 0) return ${step.value};` : ''} return input + ${step.value}; }\n`,
                );
              }
              writeConsumer(root, files);
              const affected = ['entry.ts', ...[...files].map((id) => `f${id}.ts`)];
              const update = created.emitter.advance({
                modifiedFiles: step.value === null ? ['entry.ts'] : ['entry.ts', file],
                removedFiles: step.value === null ? [file] : [],
                affectedFiles: affected,
              });
              for (const fragment of update.fragments)
                retained.set(fragment.relativePath, Buffer.from(fragment.bytes ?? []));
              const fresh = cleanOracle(root, loaded.runtime);
              assert.deepEqual([...fresh.keys()].sort(), [...affected].sort());
              assert.deepEqual([...retained.keys()].sort(), [...fresh.keys()].sort());
              for (const [path, bytes] of fresh) assert.deepEqual(retained.get(path), bytes, path);
              for (const id of files) {
                const document = loaded.runtime.Document.deserializeBinary(retained.get(`f${id}.ts`)!);
                assert.ok(
                  document.occurrences.some(
                    (occurrence) => occurrence.symbol.includes(`value${id}().`) && (occurrence.symbol_roles & 1) === 1,
                  ),
                );
              }
            }
          } finally {
            rmSync(root, { recursive: true, force: true });
          }
        },
      ),
      'compiler',
    );
  },
  PROPERTY_TIMEOUT,
);
