import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { loadTypeScriptDocumentRuntime } from '../../src/reindex/typescript-document-emitter.js';
import { TypeScriptIndexServiceHost } from '../../src/reindex/typescript-index-service.js';
import { TypeScriptIndexRequester } from '../../src/reindex/typescript-index-requester.js';
import {
  type TypeScriptIndexDocumentRequest,
  validTypeScriptDocumentReferences,
} from '../../src/reindex/typescript-index-protocol.js';
import { commitTypeScriptOverlay, readTypeScriptOverlay } from '../../src/reindex/typescript-overlay-store.js';
import { typeScriptIntermediateOverlayGenerationIdentity } from '../../src/reindex/typescript-incremental-index.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const loaded = loadTypeScriptDocumentRuntime();
  if (!loaded.available) throw new Error(loaded.reason);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'scip-retained-docs-')));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'retained-documents', version: '1.0.0' }));
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true }, files: ['a.ts', 'b.ts'] }),
  );
  writeFileSync(join(root, 'a.ts'), 'export function value(): number { return 1; }');
  writeFileSync(join(root, 'b.ts'), "import {value} from './a'; export const result = value();");
  const request: TypeScriptIndexDocumentRequest = {
    kind: 'emit-documents',
    tsconfigPath: 'tsconfig.json',
    projectArgument: '.',
    projectIdentity: 'project',
    producerIdentity: loaded.producerIdentity,
    modifiedFiles: ['a.ts'],
    removedFiles: [],
    affectedFiles: ['a.ts', 'b.ts'],
  };
  const host = new TypeScriptIndexServiceHost({ projectRoot: root, currentGeneration: () => 'base' });
  const first = host.handle('base', request);
  const knownDocuments = first.fragments.map((fragment) => {
    const bytes = Buffer.from(fragment.bytesBase64!, 'base64');
    return {
      relativePath: fragment.relativePath,
      blobHash: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.length,
    };
  });
  return { root, runtime: loaded.runtime, host, request, first, knownDocuments };
}

test('retains exact published bytes without decoding cached consumer documents', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'a.ts'), 'export function value(): number { return 2; }');
  const decode = vi.spyOn(f.runtime.Document, 'deserializeBinary');
  const next = f.host.handle('base', { ...f.request, knownDocuments: f.knownDocuments });
  expect(next.fragments).toEqual([]);
  expect(next.retainedDocuments).toEqual(f.knownDocuments);
  expect(decode).not.toHaveBeenCalled();
  expect(JSON.stringify(next).length).toBeLessThan(1_000);
  f.host.close();
});

test('does not confuse an unaccepted prior emission with documents held by the receiver', () => {
  const f = fixture();
  const wrong = f.knownDocuments.map((entry) => ({ ...entry, blobHash: '0'.repeat(64) }));
  const next = f.host.handle('base', { ...f.request, modifiedFiles: [], knownDocuments: wrong });
  expect(next.retainedDocuments).toBeUndefined();
  expect(next.fragments).toEqual(f.first.fragments);
  expect(() => f.host.handle('other-generation', { ...f.request, knownDocuments: f.knownDocuments })).toThrow(
    'published generation',
  );
  f.host.close();
});

test('changed exported types replace both provider and consumer despite prior hashes', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'a.ts'), 'export function value(): string { return "changed"; }');
  const next = f.host.handle('base', { ...f.request, knownDocuments: f.knownDocuments });
  expect(next.retainedDocuments).toBeUndefined();
  expect(next.fragments.map((fragment) => fragment.relativePath)).toEqual(['a.ts', 'b.ts']);
  expect(next.fragments[1]!.bytesBase64).not.toBe(f.first.fragments[1]!.bytesBase64);
  f.host.close();
});

test('requester rejects retained bytes it never requested, duplicate coverage and forged hashes', () => {
  const f = fixture();
  const requester = (retainedDocuments: typeof f.knownDocuments) =>
    new TypeScriptIndexRequester(
      { projectRoot: f.root, cacheDir: join(f.root, 'cache'), baseGeneration: 'base' },
      {
        emitLocally: () => ({
          producerIdentity: f.request.producerIdentity,
          cold: false,
          durationMs: 0,
          fragments: [],
          retainedDocuments,
        }),
      },
    );
  expect(() => requester(f.knownDocuments).request(f.request)).toThrow('requester does not hold');
  expect(() =>
    requester([...f.knownDocuments, f.knownDocuments[0]!]).request({ ...f.request, knownDocuments: f.knownDocuments }),
  ).toThrow('invalid retained');
  const forged = f.knownDocuments.map((entry) => ({ ...entry, byteLength: entry.byteLength + 1 }));
  expect(() => requester(forged).request({ ...f.request, knownDocuments: f.knownDocuments })).toThrow(
    'requester does not hold',
  );
  expect(
    requester(f.knownDocuments).request({ ...f.request, knownDocuments: f.knownDocuments }).retainedDocuments,
  ).toEqual(f.knownDocuments);
  f.host.close();
});

test('overlay retention validates saved bytes, prior generation and complete replacement coverage', () => {
  const f = fixture();
  const cacheDir = join(f.root, 'cache');
  mkdirSync(cacheDir);
  const fragments = f.first.fragments.map((fragment) => ({
    ...fragment,
    bytes: Buffer.from(fragment.bytesBase64!, 'base64'),
  }));
  const base = {
    cacheDir,
    previousGenerationIdentity: 'base',
    nextGenerationIdentity: 'one',
    producerIdentity: f.request.producerIdentity,
    projectIdentity: 'project',
    baseShardCurrent: true,
    fragments,
  };
  const previous = commitTypeScriptOverlay(base);
  const retain = {
    ...base,
    previousGenerationIdentity: 'one',
    nextGenerationIdentity: 'two',
    baseShardCurrent: false,
    fragments: [],
    retainedDocuments: f.knownDocuments,
  };
  expect(commitTypeScriptOverlay(retain).overlays).toEqual(previous.overlays);
  expect(commitTypeScriptOverlay(retain).overlays).toEqual(previous.overlays);
  expect(() =>
    commitTypeScriptOverlay({
      ...retain,
      nextGenerationIdentity: 'bad',
      retainedDocuments: [f.knownDocuments[0]!, f.knownDocuments[0]!],
    }),
  ).toThrow('duplicate');
  expect(() =>
    commitTypeScriptOverlay({ ...retain, nextGenerationIdentity: 'bad', fragments: [fragments[0]!] }),
  ).toThrow('duplicate');
  expect(() =>
    commitTypeScriptOverlay({ ...retain, nextGenerationIdentity: 'bad', previousGenerationIdentity: 'missing' }),
  ).toThrow('no matching overlay');
  expect(() =>
    commitTypeScriptOverlay({
      ...retain,
      nextGenerationIdentity: 'bad',
      retainedDocuments: [{ ...f.knownDocuments[0]!, blobHash: '0'.repeat(64) }],
    }),
  ).toThrow('accepted blob');
  const first = f.knownDocuments[0]!;
  const path = join(cacheDir, 'typescript-scip-overlays', 'blobs', `${first.blobHash}.scipdoc`);
  writeFileSync(path, Buffer.alloc(first.byteLength));
  expect(() => commitTypeScriptOverlay({ ...retain, nextGenerationIdentity: 'corrupt' })).toThrow('corrupt');
  expect(readTypeScriptOverlay(cacheDir, 'corrupt')).toBeNull();
  rmSync(path);
  expect(() => commitTypeScriptOverlay({ ...retain, nextGenerationIdentity: 'missing-blob' })).toThrow();
  expect(readTypeScriptOverlay(cacheDir, 'missing-blob')).toBeNull();
  f.host.close();
});

test('retained identities validate paths and contribute to retry-safe overlay identities', () => {
  const first = { relativePath: 'a.ts', blobHash: '1'.repeat(64), byteLength: 100 };
  const second = { relativePath: 'b.ts', blobHash: '2'.repeat(64), byteLength: 200 };
  expect(validTypeScriptDocumentReferences([first], ['a.ts'])).toBe(true);
  expect(validTypeScriptDocumentReferences([first], ['b.ts'])).toBe(false);
  expect(validTypeScriptDocumentReferences([first, first], ['a.ts'])).toBe(false);
  expect(validTypeScriptDocumentReferences([{ ...first, blobHash: '../wrong' }], ['a.ts'])).toBe(false);
  const identity = (retainedDocuments: (typeof first)[]) =>
    typeScriptIntermediateOverlayGenerationIdentity({
      previousGenerationIdentity: 'before',
      targetGenerationIdentity: 'after',
      fragments: [],
      retainedDocuments,
    });
  expect(identity([first, second])).toBe(identity([second, first]));
  expect(identity([first])).not.toBe(identity([{ ...first, blobHash: second.blobHash }]));
});
