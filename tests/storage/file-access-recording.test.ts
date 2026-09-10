import { expect, test } from 'vitest';
import {
  recordFileAccess,
  recordSymbolReferenceAccess,
  withFileAccessRecording,
} from '../../src/domain/file-access-recorder.js';
import { getSourceLines, getSourceText } from '../../src/source/primitives/source-text.js';
import { getFunctionLikeDefinitionsForFile } from '../../src/symbols/definition-catalog.js';
import { withSourceDb } from '../properties/fixture.js';

test('nested computations contribute all file and empty-reference reads to their parent', () => {
  const outer: string[] = [],
    inner: string[] = [],
    references: Array<[string, readonly string[]]> = [];
  withFileAccessRecording(
    (path) => outer.push(path),
    () => {
      recordFileAccess('before.ts');
      withFileAccessRecording(
        (path) => inner.push(path),
        () => {
          recordFileAccess('inside.ts');
          recordSymbolReferenceAccess('no-callers', []);
        },
      );
      recordFileAccess('after.ts');
    },
    (symbol, files) => references.push([symbol, files]),
  );
  expect(outer).toEqual(['before.ts', 'inside.ts', 'after.ts']);
  expect(inner).toEqual(['inside.ts']);
  expect(references).toEqual([['no-callers', []]]);
  recordFileAccess('outside.ts');
  expect(outer).toHaveLength(3);
});

test.each([getSourceText, getSourceLines])('cached empty files and missing files remain distinguishable', (read) => {
  withSourceDb({ 'empty.ts': '' }, (db) => {
    read(db, 'missing.ts');
    read(db, 'empty.ts');
    const sources: Array<[string, string]> = [];
    const unavailable: string[] = [];
    withFileAccessRecording(
      () => undefined,
      () => {
        read(db, 'empty.ts');
        withFileAccessRecording(
          () => undefined,
          () => read(db, 'missing.ts'),
        );
      },
      undefined,
      { source: (file, text) => sources.push([file, text]), unavailable: (file) => unavailable.push(file) },
    );
    expect(sources).toEqual([
      ['empty.ts', ''],
      ['missing.ts', ''],
    ]);
    expect(unavailable).toEqual(['missing.ts']);
  });
});

test('a failed nested computation restores its parent recorder', () => {
  const outer: string[] = [],
    inner: string[] = [];
  const outerReferences: Array<[string, readonly string[]]> = [];
  const innerReferences: Array<[string, readonly string[]]> = [];
  withFileAccessRecording(
    (path) => outer.push(path),
    () => {
      expect(() =>
        withFileAccessRecording(
          (path) => inner.push(path),
          () => {
            recordFileAccess('failed.ts');
            recordSymbolReferenceAccess('failed', ['failed.ts']);
            throw new Error('stop');
          },
          (symbol, files) => innerReferences.push([symbol, files]),
        ),
      ).toThrow('stop');
      recordFileAccess('recovered.ts');
      recordSymbolReferenceAccess('recovered', []);
    },
    (symbol, files) => outerReferences.push([symbol, files]),
  );
  expect(outer).toEqual(['failed.ts', 'recovered.ts']);
  expect(inner).toEqual(['failed.ts']);
  expect(outerReferences).toEqual([
    ['failed', ['failed.ts']],
    ['recovered', []],
  ]);
  expect(innerReferences).toEqual([['failed', ['failed.ts']]]);
  recordSymbolReferenceAccess('outside', []);
  expect(outerReferences).toHaveLength(2);
});

test.each([
  ['source lines', getSourceLines],
  ['function definitions', getFunctionLikeDefinitionsForFile],
] as const)('warm %s reads retain the same source dependency as cold reads', (_name, read) => {
  withSourceDb({ 'a.ts': 'export function answer() { return 42; }\n' }, (db) => {
    const first = read(db, 'a.ts');
    const files = new Set<string>();
    const cached = withFileAccessRecording(
      (file) => files.add(file),
      () => read(db, 'a.ts'),
    );
    expect(cached).toEqual(first);
    expect(files.has('a.ts')).toBe(true);
  });
});
