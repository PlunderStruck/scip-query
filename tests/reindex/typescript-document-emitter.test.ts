import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import {
  createTypeScriptDocumentEmitter,
  loadTypeScriptDocumentRuntime,
  type TypeScriptDocumentRuntime,
} from '../../src/reindex/typescript-document-emitter.js';

const require = createRequire(import.meta.url);

describe('TypeScriptDocumentEmitter', () => {
  test('reports an unavailable optional runtime without constructing compiler state', () => {
    expect(
      createTypeScriptDocumentEmitter({
        workspaceRoot: '/tmp/unavailable',
        tsconfigPath: 'tsconfig.json',
        runtime: null,
      }),
    ).toEqual({ available: false, reason: 'scip-typescript document runtime unavailable' });
  });

  test('retains exact full documents and exact affected documents across repeated edits', () => {
    const availability = loadTypeScriptDocumentRuntime();
    expect(availability.available).toBe(true);
    if (!availability.available) return;

    const root = realpathSync(mkdtempSync(join(tmpdir(), 'scip-query-document-emitter-')));
    writeFixture(root);
    const created = createTypeScriptDocumentEmitter({
      workspaceRoot: root,
      tsconfigPath: 'tsconfig.json',
      projectRoot: '.',
      runtime: availability.runtime,
    });
    expect(created.available).toBe(true);
    if (!created.available) return;

    const emitter = created.emitter;
    const initial = emitter.initialize();
    const initialOracle = cleanOracle(root, availability.runtime);
    expect(initial.fragments.map((fragment) => fragment.relativePath).sort()).toEqual([...initialOracle.keys()].sort());
    for (const fragment of initial.fragments) {
      expect(Buffer.from(fragment.bytes ?? [])).toEqual(initialOracle.get(fragment.relativePath));
    }

    writeFileSync(
      join(root, 'src/a.ts'),
      [
        'export interface Shape { point: { x: number; y: number; z: number } }',
        'export const origin: Shape = { point: { x: 0, y: 0, z: 0 } };',
        '',
      ].join('\n'),
    );
    const first = emitter.advance({ modifiedFiles: ['src/a.ts'], affectedFiles: ['src/a.ts', 'src/b.ts'] });
    const firstOracle = cleanOracle(root, availability.runtime);
    expectFragmentsEqual(first.fragments, firstOracle);
    expect(first.stats.sourceNodesReplaced).toBe(1);
    expect(first.stats.symbolEntriesPruned).toBeGreaterThan(0);

    writeFileSync(
      join(root, 'src/a.ts'),
      [
        'export interface Shape { point: { x: number; y: number; z: number }; name: string }',
        "export const origin: Shape = { point: { x: 0, y: 0, z: 0 }, name: 'origin' };",
        '',
      ].join('\n'),
    );
    const second = emitter.advance({ modifiedFiles: ['src/a.ts'], affectedFiles: ['src/a.ts', 'src/b.ts'] });
    const secondOracle = cleanOracle(root, availability.runtime);
    expectFragmentsEqual(second.fragments, secondOracle);
    expect(second.stats.programUpdates).toBe(2);
    expect(second.stats.sourceNodesReplaced).toBe(2);
    expect(second.stats.symbolEntriesPruned).toBeGreaterThan(first.stats.symbolEntriesPruned);
  });
});

function writeFixture(root: string): void {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'emitter-fixture', version: '1.0.0' }));
  mkdirSync(join(root, 'node_modules/@types/probe'), { recursive: true });
  writeFileSync(
    join(root, 'node_modules/@types/probe/package.json'),
    JSON.stringify({ name: '@types/probe', version: '1.0.0', types: 'index.d.ts' }),
  );
  writeFileSync(join(root, 'node_modules/@types/probe/index.d.ts'), 'interface ProbeGlobal { value: number }\n');
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        types: ['probe'],
      },
      include: ['src/**/*.ts'],
    }),
  );
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src/a.ts'),
    [
      'export interface Shape { point: { x: number; y: number } }',
      'export const origin: Shape = { point: { x: 0, y: 0 } };',
      'export const ambient: ProbeGlobal = { value: 1 };',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'src/b.ts'),
    ["import { origin, type Shape } from './a.js';", 'export const selected: Shape = origin;', ''].join('\n'),
  );
}

function cleanOracle(root: string, runtime: TypeScriptDocumentRuntime): Map<string, Buffer> {
  const packagePath = require.resolve('@sourcegraph/scip-typescript/package.json');
  const mainPath = join(dirname(packagePath), 'dist/src/main.js');
  const outputPath = join(root, 'oracle.scip');
  execFileSync(process.execPath, [mainPath, 'index', '--cwd', root, '--output', outputPath, '--no-progress-bar', '.'], {
    cwd: root,
    stdio: 'pipe',
  });
  const index = runtime.Index.deserializeBinary(readFileSync(outputPath));
  return new Map(index.documents.map((document) => [document.relative_path, Buffer.from(document.serializeBinary())]));
}

function expectFragmentsEqual(
  fragments: readonly { relativePath: string; bytes: Uint8Array | null }[],
  oracle: ReadonlyMap<string, Buffer>,
): void {
  for (const fragment of fragments) {
    expect(Buffer.from(fragment.bytes ?? [])).toEqual(oracle.get(fragment.relativePath));
  }
}
