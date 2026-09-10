import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  createTypeScriptDocumentEmitter,
  loadTypeScriptDocumentRuntime,
} from '../../src/reindex/typescript-document-emitter.js';
import { TypeScriptFragmentCache } from '../../src/reindex/typescript-document-blob.js';
import { cleanOracle } from '../fixtures/typescript-oracle.js';

const cases = [
  {
    name: 'explicit return body',
    before: 'export function value(x: number): number { return x + 1; }',
    after: 'export function value(x: number): number { return x + 2; }',
    consumer: "import {value} from './a'; export const result = value(3);",
    reuse: true,
  },
  {
    name: 'inferred return body',
    before: 'export function value(x: number) { return x + 1; }',
    after: 'export function value(x: number) { return x + 2; }',
    consumer: "import {value} from './a'; export const result = value(3);",
    reuse: true,
  },
  {
    name: 'inferred literal type changes',
    before: 'export const value = 1;',
    after: 'export const value = 2;',
    consumer: "import {value} from './a'; export const result = value;",
    reuse: false,
  },
  {
    name: 'member paths swap while the set of origins is unchanged',
    before: 'const a = {x: 1}; const b = {x: 2}; export const value = {left: a, right: b};',
    after: 'const a = {x: 1}; const b = {x: 2}; export const value = {left: b, right: a};',
    consumer: "import {value} from './a'; export const result = value.left.x;",
    reuse: false,
  },
  {
    name: 'equal-shaped selected anonymous origin changes',
    before: 'const a = {x: 1}; const b = {x: 2}; export const value = a;',
    after: 'const a = {x: 1}; const b = {x: 2}; export const value = b;',
    consumer: "import {value} from './a'; export const result = value.x;",
    reuse: false,
  },
  {
    name: 'anonymous declarations move',
    before: 'export const value = {x: 1};',
    after: '\nexport const value = {x: 1};',
    consumer: "import {value} from './a'; export const result = value.x;",
    reuse: false,
  },
  {
    name: 'export aliases change targets',
    before: 'const a = {x: 1}; const b = {x: 2}; export {a as value};',
    after: 'const a = {x: 1}; const b = {x: 2}; export {b as value};',
    consumer: "import {value} from './a'; export const result = value.x;",
    reuse: false,
  },
  {
    name: 'generic function falls back conservatively',
    before: 'export function value<T>(x: T): T { return x; }',
    after: 'export function value<T>(x: T): T {  return x; }',
    consumer: "import {value} from './a'; export const result = value({x: 1}).x;",
    reuse: false,
  },
  {
    name: 'documentation changes',
    before: '/** First description. */ export function value(x: number) { return x; }',
    after: '/** Other description. */ export function value(x: number) { return x; }',
    consumer: "import {value} from './a'; export const result = value(1);",
    reuse: false,
  },
  {
    name: 'global augmentation changes',
    before: 'export {}; declare global { interface GlobalValue {x: number} }',
    after: 'export {}; declare global { interface GlobalValue {x: string} }',
    consumer: 'declare const value: GlobalValue; export const result = value.x;',
    reuse: false,
  },
  {
    name: 'unresolved public type falls back',
    before: 'export const value: MissingType = 1;',
    after: 'export const value: MissingType = 2;',
    consumer: "import {value} from './a'; export const result = value.x;",
    reuse: false,
  },
  {
    name: 'mapped values preserve their declaration targets',
    before:
      'declare function copy<T>(v: T): {[P in keyof T]: T[P]}; const a={x:1}; const b={x:2}; export const value=copy(a);',
    after:
      'declare function copy<T>(v: T): {[P in keyof T]: T[P]}; const a={x:1}; const b={x:2}; export const value=copy(b);',
    consumer: "import {value} from './a'; export const result = value.x;",
    reuse: false,
  },
];

function fixture(provider: string, consumer: string) {
  const availability = loadTypeScriptDocumentRuntime();
  if (!availability.available) throw new Error(availability.reason);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'scip-boundary-reuse-')));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'boundary-reuse', version: '1.0.0' }));
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true, noEmit: true },
      files: ['a.ts', 'b.ts'],
    }),
  );
  writeFileSync(join(root, 'a.ts'), provider);
  writeFileSync(join(root, 'b.ts'), consumer);
  const created = createTypeScriptDocumentEmitter({ workspaceRoot: root, tsconfigPath: 'tsconfig.json' });
  if (!created.available) throw new Error(created.reason);
  return { root, emitter: created.emitter, runtime: availability.runtime };
}

describe('compiler boundary document reuse', () => {
  test.each(cases)('$name', ({ before, after, consumer, reuse }) => {
    const { root, emitter, runtime } = fixture(before, consumer);
    try {
      emitter.initialize();
      writeFileSync(join(root, 'a.ts'), after);
      const updated = emitter.advance({ modifiedFiles: ['a.ts'], affectedFiles: ['a.ts', 'b.ts'] });
      expect(updated.stats.documentsReused).toBe(reuse ? 1 : 0);
      const oracle = cleanOracle(root, runtime);
      for (const fragment of updated.fragments)
        expect(Buffer.from(fragment.bytes ?? [])).toEqual(oracle.get(fragment.relativePath));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not retain caller-mutated buffers, including across later batches and retries', () => {
    const { root, emitter, runtime } = fixture(cases[0]!.before, cases[0]!.consumer);
    try {
      const initial = emitter.initialize();
      for (const fragment of initial.fragments) fragment.bytes?.fill(0);
      writeFileSync(join(root, 'a.ts'), cases[0]!.after);
      const changed = emitter.advance({ modifiedFiles: ['a.ts'], affectedFiles: ['a.ts'] });
      changed.fragments[0]!.bytes?.fill(0);
      const consumer = emitter.advance({ modifiedFiles: [], affectedFiles: ['b.ts'] });
      expect(consumer.stats.documentsReused).toBe(1);
      const oracle = cleanOracle(root, runtime);
      expect(Buffer.from(consumer.fragments[0]!.bytes!)).toEqual(oracle.get('b.ts'));
      consumer.fragments[0]!.bytes?.fill(0);
      const retry = emitter.advance({ modifiedFiles: [], affectedFiles: ['a.ts', 'b.ts'] });
      for (const fragment of retry.fragments)
        expect(Buffer.from(fragment.bytes!)).toEqual(oracle.get(fragment.relativePath));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('invalidates cache before an update that fails affected-path validation', () => {
    const { root, emitter, runtime } = fixture(cases[2]!.before, cases[2]!.consumer);
    try {
      emitter.initialize();
      writeFileSync(join(root, 'a.ts'), cases[2]!.after);
      expect(() => emitter.advance({ modifiedFiles: ['a.ts'], affectedFiles: ['missing.ts'] })).toThrow();
      const retry = emitter.advance({ modifiedFiles: ['a.ts'], affectedFiles: ['a.ts', 'b.ts'] });
      expect(retry.stats.documentsReused).toBe(0);
      const oracle = cleanOracle(root, runtime);
      for (const fragment of retry.fragments)
        expect(Buffer.from(fragment.bytes!)).toEqual(oracle.get(fragment.relativePath));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('configuration changes invalidate retained documents', () => {
    const { root, emitter, runtime } = fixture('export const value = null;', cases[2]!.consumer);
    try {
      emitter.initialize();
      const config = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'));
      config.compilerOptions.strict = false;
      writeFileSync(join(root, 'tsconfig.json'), JSON.stringify(config));
      const updated = emitter.advance({ modifiedFiles: ['a.ts'], affectedFiles: ['a.ts', 'b.ts'] });
      expect(updated.stats.documentsReused).toBe(0);
      const oracle = cleanOracle(root, runtime);
      for (const fragment of updated.fragments)
        expect(Buffer.from(fragment.bytes!)).toEqual(oracle.get(fragment.relativePath));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('changed import order can change global overload precedence without changing the module exports', () => {
    const { root, emitter, runtime } = fixture(
      "import './first'; import './second'; export {};",
      'export const result = globalChoice();',
    );
    try {
      writeFileSync(join(root, 'first.ts'), 'declare function globalChoice(): number;');
      writeFileSync(join(root, 'second.ts'), 'declare function globalChoice(): string;');
      emitter.initialize();
      writeFileSync(join(root, 'a.ts'), "import './second'; import './first'; export {};");
      const updated = emitter.advance({ modifiedFiles: ['a.ts'], affectedFiles: ['a.ts', 'b.ts'] });
      expect(updated.stats.documentsReused).toBe(0);
      const oracle = cleanOracle(root, runtime);
      for (const fragment of updated.fragments)
        expect(Buffer.from(fragment.bytes!)).toEqual(oracle.get(fragment.relativePath));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('library generic arguments retain anonymous declaration origins', () => {
    const provider = (name: string) =>
      `import type {Box} from './library'; const a={x:1}; const b={x:2}; export const value: Box<typeof ${name}> = {item: ${name}};`;
    const { root, emitter, runtime } = fixture(
      provider('a'),
      "import {value} from './a'; export const result = value.item.x;",
    );
    try {
      writeFileSync(join(root, 'library.d.ts'), 'export interface Box<T> {item: T}');
      emitter.initialize();
      writeFileSync(join(root, 'a.ts'), provider('b'));
      const updated = emitter.advance({ modifiedFiles: ['a.ts'], affectedFiles: ['a.ts', 'b.ts'] });
      expect(updated.stats.documentsReused).toBe(0);
      const oracle = cleanOracle(root, runtime);
      for (const fragment of updated.fragments)
        expect(Buffer.from(fragment.bytes!)).toEqual(oracle.get(fragment.relativePath));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('serialized document cache bounds bytes and entries, and owns both writes and reads', () => {
  const cache = new TypeScriptFragmentCache(4, 2);
  const bytes = Buffer.from([1, 2]);
  cache.set('a', bytes);
  bytes.fill(9);
  expect(cache.get('a')).toEqual(Uint8Array.of(1, 2));
  cache.get('a')!.fill(0);
  expect(cache.get('a')).toEqual(Uint8Array.of(1, 2));
  cache.set('b', Uint8Array.of(3, 4, 5));
  expect(cache.get('a')).toBeUndefined();
  cache.set('empty', null);
  expect(cache.get('empty')).toBeNull();
  cache.set('another', null);
  expect(cache.get('b')).toBeUndefined();
  cache.set('oversize', Uint8Array.of(1, 2, 3, 4, 5));
  expect(cache.get('oversize')).toBeUndefined();
});

test('compresses retained documents without retaining or returning shared buffers', () => {
  const cache = new TypeScriptFragmentCache(8_192);
  const source = new Uint8Array(8_192).fill(42);
  cache.set('first', source);
  cache.set('second', source);
  source.fill(0);
  expect(Uint8Array.from(cache.get('first')!)).toEqual(new Uint8Array(8_192).fill(42));
  cache.get('first')!.fill(0);
  expect(Uint8Array.from(cache.get('first')!)).toEqual(new Uint8Array(8_192).fill(42));
  expect(Uint8Array.from(cache.get('second')!)).toEqual(new Uint8Array(8_192).fill(42));
});

test('a scan larger than the cache reuses prior documents before admitting replacements', () => {
  const cache = new TypeScriptFragmentCache(4);
  cache.set('later', Uint8Array.of(1, 2));
  cache.set('last', Uint8Array.of(3, 4));
  cache.protectForGeneration();
  cache.set('first', Uint8Array.of(5, 6));
  expect(cache.get('first')).toBeUndefined();
  expect(cache.get('later')).toEqual(Uint8Array.of(1, 2));
  cache.set('middle', Uint8Array.of(7, 8));
  expect(cache.get('last')).toEqual(Uint8Array.of(3, 4));
  expect(cache.get('middle')).toEqual(Uint8Array.of(7, 8));
  expect(cache.get('later')).toBeUndefined();
});
