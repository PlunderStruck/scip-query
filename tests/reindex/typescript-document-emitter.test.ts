import { TypeScriptFragmentCache } from '../../src/reindex/typescript-document-blob.js';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  createTypeScriptDocumentEmitter,
  loadTypeScriptDocumentRuntime,
} from '../../src/reindex/typescript-document-emitter.js';

import { cleanOracle } from '../fixtures/typescript-oracle.js';

describe('TypeScriptDocumentEmitter', () => {
  test.each([
    {
      name: 'removed unused export',
      before: 'export function used(): number { return 1; }\nexport function unused(): number { return 2; }\n',
      after: 'export function used(): number { return 1; }\n',
      consumer: "import { used } from './a'; export const result = used();\n",
      downstream: "import { result } from './b'; export const final = result;\n",
      reused: 2,
    },
    {
      name: 'removed unused export together with a body edit',
      before: 'export function used(): number { return 1; }\nexport function unused(): number { return 2; }\n',
      after: 'export function used(): number { return 3; }\n',
      consumer: "import { used } from './a'; export const result = used();\n",
      downstream: "import { result } from './b'; export const final = result;\n",
      reused: 2,
    },
    {
      name: 'removed unused export together with a public type change',
      before: 'export function used() { return 1; }\nexport function unused(): number { return 2; }\n',
      after: 'export function used() { return "changed"; }\n',
      consumer: "import { used } from './a'; export const result = used();\n",
      downstream: "import { result } from './b'; export const final = result;\n",
      reused: 0,
    },
    {
      name: 'removed export referenced inside the module',
      before: 'export function used() { return unused(); }\nexport function unused(): number { return 2; }\n',
      after: 'export function used() { return unused(); }\n',
      consumer: "import { used } from './a'; export const result = used();\n",
      downstream: "import { result } from './b'; export const final = result;\n",
      reused: 0,
    },
    {
      name: 'changed exported consumer type',
      before: 'export function used() { return 1; }\n',
      after: 'export function used() { return "changed"; }\n',
      consumer: "import { used } from './a'; export const result = used();\n",
      downstream: "import { result } from './b'; export const final = result;\n",
      reused: 0,
    },
    {
      name: 'namespace reexport changes',
      before: 'export function used(): number { return 1; }\nexport function unused(): number { return 2; }\n',
      after: 'export function used(): number { return 1; }\n',
      consumer: "export * as result from './a';\n",
      downstream: "import { result } from './b'; export const final = result;\n",
      reused: 0,
    },
    {
      name: 'previously unresolved named import',
      before: 'export function used(): number { return 1; }\n',
      after: 'export function used(): number { return 1; }\nexport function added(): string { return "new"; }\n',
      consumer: "import { added } from './a'; export const result = added();\n",
      downstream: "import { result } from './b'; export const final = result;\n",
      reused: 0,
    },
    {
      name: 'literal type behind a consumer alias',
      before: 'export type Mode = "a";\n',
      after: 'export type Mode = "b";\n',
      consumer: "import type { Mode } from './a'; export type ModeAlias = Mode;\n",
      downstream: "import type { ModeAlias } from './b'; export const result = null as unknown as ModeAlias;\n",
      reused: 0,
    },
    {
      name: 'equal types with changed declaration origins',
      before: 'const aa = { value: 1 }; const bb = { value: 2 }; export function used() { return aa; }\n',
      after: 'const aa = { value: 1 }; const bb = { value: 2 }; export function used() { return bb; }\n',
      consumer: "import { used } from './a'; export const result = used();\n",
      downstream: "import { result } from './b'; export const final = result.value;\n",
      reused: 0,
    },
  ])(
    'bounds isolated export changes at compiler-resolved consumers: $name',
    ({ before, after, consumer, downstream, reused }) => {
      const loaded = loadTypeScriptDocumentRuntime();
      if (!loaded.available) throw new Error(loaded.reason);
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'scip-consumer-boundary-')));
      try {
        writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'consumer-boundary', version: '1.0.0' }));
        writeFileSync(
          join(root, 'tsconfig.json'),
          JSON.stringify({ compilerOptions: { strict: true }, files: ['a.ts', 'b.ts', 'c.ts'] }),
        );
        writeFileSync(join(root, 'a.ts'), before);
        writeFileSync(join(root, 'b.ts'), consumer);
        writeFileSync(join(root, 'c.ts'), downstream);
        const created = createTypeScriptDocumentEmitter({
          workspaceRoot: root,
          tsconfigPath: 'tsconfig.json',
          runtime: loaded.runtime,
        });
        if (!created.available) throw new Error(created.reason);
        created.emitter.initialize();
        writeFileSync(join(root, 'a.ts'), after);
        const result = created.emitter.advance({ modifiedFiles: ['a.ts'], affectedFiles: ['a.ts', 'b.ts', 'c.ts'] });
        expect(result.stats.documentsReused).toBe(reused);
        expectFragmentsEqual(result.fragments, cleanOracle(root, loaded.runtime));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test.each([false, true])('restores a prior compiler program from verified documents (BOM: %s)', (bom) => {
    const loaded = loadTypeScriptDocumentRuntime();
    if (!loaded.available) throw new Error(loaded.reason);
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'scip-compiler-recovery-')));
    const before = (bom ? '\uFEFF' : '') + 'export function used(value: number): number { return value + 1; }\n';
    const after = before.replace('value + 1', 'value + 2');
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'compiler-recovery', version: '1.0.0' }));
      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { strict: true }, files: ['a.ts', 'b.ts', 'c.ts'] }),
      );
      writeFileSync(join(root, 'a.ts'), before);
      writeFileSync(join(root, 'b.ts'), "import { used } from './a'; export const result = used(1);\n");
      writeFileSync(join(root, 'c.ts'), "import { result } from './b'; export const final = result;\n");
      const documents = new TypeScriptFragmentCache();
      for (const [path, bytes] of cleanOracle(root, loaded.runtime)) documents.set(path, bytes);
      writeFileSync(join(root, 'a.ts'), after);
      const created = createTypeScriptDocumentEmitter({
        workspaceRoot: root,
        tsconfigPath: 'tsconfig.json',
        runtime: loaded.runtime,
      });
      if (!created.available) throw new Error(created.reason);
      created.emitter.restoreCheckpoint({ sources: new Map([['a.ts', before]]), documents });
      const result = created.emitter.advance({ modifiedFiles: ['a.ts'], affectedFiles: ['a.ts', 'b.ts', 'c.ts'] });
      expect(result.stats.documentsReused).toBe(2);
      expect(result.stats.documentsEmitted).toBe(1);
      expectFragmentsEqual(result.fragments, cleanOracle(root, loaded.runtime));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refreshes consumer definition targets even when the provider document and public types are unchanged', () => {
    const availability = loadTypeScriptDocumentRuntime();
    expect(availability.available).toBe(true);
    if (!availability.available) return;
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'scip-query-definition-provenance-')));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'provenance-fixture', version: '1.0.0' }));
      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true },
          files: ['a.ts', 'b.ts'],
        }),
      );
      writeFileSync(join(root, 'b.ts'), "import { chosen } from './a';\nexport const result = chosen.value;\n");
      const provider = (condition: string) =>
        [
          'const a = { value: 1 };',
          'const b = { value: 2 };',
          'export function choose<T extends boolean>(): T extends true ? typeof a : typeof b { return null as any; }',
          `export const chosen = choose<${condition}>();`,
        ].join('\n');
      // Equal-width edits leave all provider SCIP ranges, declarations and
      // reference occurrences unchanged. Both exported types are { value: number }.
      writeFileSync(join(root, 'a.ts'), provider('true '));
      const created = createTypeScriptDocumentEmitter({
        workspaceRoot: root,
        tsconfigPath: 'tsconfig.json',
        runtime: availability.runtime,
      });
      expect(created.available).toBe(true);
      if (!created.available) return;
      const before = created.emitter.initialize().fragments;
      writeFileSync(join(root, 'a.ts'), provider('false'));
      const after = created.emitter.advance({ modifiedFiles: ['a.ts'], affectedFiles: ['a.ts', 'b.ts'] }).fragments;
      expect(after.find((fragment) => fragment.relativePath === 'a.ts')?.bytes).toEqual(
        before.find((fragment) => fragment.relativePath === 'a.ts')?.bytes,
      );
      const target = (fragments: typeof before) =>
        fragments
          .find((fragment) => fragment.relativePath === 'b.ts')!
          .referenceFragments.find((fragment) => fragment.targetSymbol.includes('/value$'))?.targetSymbol;
      expect(target(before)).toContain('/value$12:');
      expect(target(after)).toContain('/value$36:');
      expectFragmentsEqual(after, cleanOracle(root, availability.runtime));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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
    const consumerReferences = initial.fragments.find(
      (fragment) => fragment.relativePath === 'src/b.ts',
    )?.referenceFragments;
    expect(consumerReferences?.length).toBeGreaterThan(0);
    expect(consumerReferences?.every((fragment) => fragment.location.file === 'src/b.ts')).toBe(true);

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

    writeFileSync(join(root, 'src/c.ts'), 'export const extra = 1;\n');
    const added = emitter.advance({ modifiedFiles: ['src/c.ts'], affectedFiles: ['src/c.ts'] });
    const addedOracle = cleanOracle(root, availability.runtime);
    expect(added.fragments.map((fragment) => fragment.relativePath)).toEqual(['src/c.ts']);
    expectFragmentsEqual(added.fragments, addedOracle);
    expect(added.stats.programUpdates).toBe(3);

    rmSync(join(root, 'src/c.ts'));
    const removed = emitter.advance({ modifiedFiles: [], removedFiles: ['src/c.ts'], affectedFiles: [] });
    expect(removed.fragments).toEqual([]);
    expect(removed.stats).toMatchObject({ programUpdates: 4, documentsRemoved: 1 });
  });

  test('initializes a cold compiler without emitting unrelated documents', () => {
    const availability = loadTypeScriptDocumentRuntime();
    expect(availability.available).toBe(true);
    if (!availability.available) return;

    const root = realpathSync(mkdtempSync(join(tmpdir(), 'scip-query-document-emitter-cold-')));
    writeFixture(root);
    const created = createTypeScriptDocumentEmitter({
      workspaceRoot: root,
      tsconfigPath: 'tsconfig.json',
      projectRoot: '.',
      runtime: availability.runtime,
    });
    expect(created.available).toBe(true);
    if (!created.available) return;

    writeFileSync(
      join(root, 'src/a.ts'),
      [
        'export interface Shape { point: { x: number; y: number; z: number } }',
        'export const origin: Shape = { point: { x: 0, y: 0, z: 0 } };',
        '',
      ].join('\n'),
    );
    const result = created.emitter.advance({ modifiedFiles: ['src/a.ts'], affectedFiles: ['src/b.ts'] });
    const oracle = cleanOracle(root, availability.runtime);

    expect(result.fragments.map((fragment) => fragment.relativePath)).toEqual(['src/b.ts']);
    expectFragmentsEqual(result.fragments, oracle);
    expect(result.stats).toMatchObject({ initializations: 1, programUpdates: 0, documentsEmitted: 1 });
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

function expectFragmentsEqual(
  fragments: readonly { relativePath: string; bytes: Uint8Array | null }[],
  oracle: ReadonlyMap<string, Buffer>,
): void {
  for (const fragment of fragments) {
    expect(Buffer.from(fragment.bytes ?? [])).toEqual(oracle.get(fragment.relativePath));
  }
}
