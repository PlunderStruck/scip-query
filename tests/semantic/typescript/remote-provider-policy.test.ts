import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SymbolInformation_Kind } from '@c4312/scip';
import { ScipDatabase } from '../../../src/storage/db.js';
import { createServiceBackedTypeScriptProvider } from '../../../src/semantic/typescript/remote-provider.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

/**
 * A service failure on a large index must not turn into an in-process
 * compiler load: that is the work the service's bounded worker just failed,
 * repeated inside a command process with a smaller heap. Below the large
 * index thresholds the direct compiler remains the fallback.
 */
describe('service-backed TypeScript provider fallback policy', { timeout: 60_000 }, () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function fixture(documents: number): { root: string; db: ScipDatabase } {
    const root = mkdtempSync(join(tmpdir(), 'scip-remote-policy-'));
    tempDirs.push(root);
    writeFixtureFiles(root, { 'src/a.ts': ['export function a() {', '  return 1;', '}'] });
    const dbPath = join(root, 'index.db');
    const builder = evidenceFixtureDb(dbPath)
      .symbol(1, 'scip-typescript npm fixture 1.0.0 src/`a.ts`/a().', 'a', SymbolInformation_Kind.Function)
      .definition(1, 1, 1, 0, 0, 2, 1)
      .chunk(1, 1, 0, 3)
      .mention(1, 1, 1);
    builder.document(1, 'typescript', 'src/a.ts');
    for (let index = 2; index <= documents; index += 1)
      builder.document(index, 'typescript', `src/generated/f${index}.ts`);
    builder.write();
    return { root, db: new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') }) };
  }

  it('declines semantic enrichment instead of loading the compiler when the index is large', () => {
    const { db } = fixture(2_600);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      // No watch service exists in the fixture cache directory, so every
      // request fails before it is written.
      const provider = createServiceBackedTypeScriptProvider(db);
      const definitions = [
        {
          symbolId: 1,
          symbol: 'scip-typescript npm fixture 1.0.0 src/`a.ts`/a().',
          relativePath: 'src/a.ts',
          documentId: 1,
          startLine: 0,
          startChar: 0,
          endLine: 2,
          endChar: 1,
          leaf: 'a',
          parentTypeName: null,
          isFunctionLike: true,
          isTypeLike: false,
          kind: SymbolInformation_Kind.Function,
          documentation: null,
          enclosingSymbol: null,
        },
      ];
      expect(provider.calleesForDefinitions?.(definitions)).toEqual(new Map());
      expect(provider.availability()).toEqual(
        expect.objectContaining({ available: false, reason: expect.stringContaining('declined') }),
      );
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(String(stderr.mock.calls[0]?.[0])).toContain('too large for an in-process compiler');
    } finally {
      db.close();
    }
  });

  it('retries a memory-failed batch as file halves before counting the service as failed', () => {
    const { db } = fixture(2_600);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const requests: number[] = [];
    const requester = {
      request(request: { kind: string; definitions?: Array<{ symbolId: number; relativePath: string }> }) {
        if (request.kind === 'availability') return { available: true, tsconfigPaths: ['tsconfig.json'] };
        const definitions = request.definitions ?? [];
        const files = new Set(definitions.map((definition) => definition.relativePath));
        requests.push(files.size);
        if (files.size > 1) {
          throw new Error(
            'TypeScript semantic worker failed: Worker terminated due to reaching memory limit: JS heap out of memory',
          );
        }
        return definitions.map((definition) => [definition.symbolId, [{ symbol: 'x', file: 'src/x.ts', line: 0 }]]);
      },
    };
    try {
      const provider = createServiceBackedTypeScriptProvider(db, undefined, { requester });
      const definition = (symbolId: number, relativePath: string) => ({
        symbolId,
        symbol: `sym${symbolId}`,
        relativePath,
        documentId: symbolId,
        startLine: 0,
        startChar: 0,
        endLine: 2,
        endChar: 1,
        leaf: 'a',
        parentTypeName: null,
        isFunctionLike: true,
        isTypeLike: false,
        kind: SymbolInformation_Kind.Function,
        documentation: null,
        enclosingSymbol: null,
      });
      const result = provider.calleesForDefinitions?.([
        definition(1, 'src/a.ts'),
        definition(2, 'src/b.ts'),
        definition(3, 'src/c.ts'),
        definition(4, 'src/d.ts'),
      ]);
      expect([...(result?.keys() ?? [])].sort()).toEqual([1, 2, 3, 4]);
      // Four files failed, both halves of two failed, four single files answered.
      expect(requests).toEqual([4, 2, 1, 1, 2, 1, 1]);
      expect(stderr).not.toHaveBeenCalled();
      expect(provider.availability().available).toBe(true);
    } finally {
      db.close();
    }
  });

  it('treats a file-scoped decline as unavailable for that request only', () => {
    const { db } = fixture(2_600);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const kinds: string[] = [];
    const requester = {
      request(request: { kind: string; definitions?: Array<{ symbolId: number }> }) {
        kinds.push(request.kind);
        if (request.kind === 'availability') {
          return { available: true, tsconfigPaths: ['tsconfig.json'], projectScope: 'file-closure' };
        }
        if (request.kind === 'references') {
          throw new Error(
            'TypeScript semantic worker failed: TypeScript project-wide semantics are unavailable: a compiler project is file-scoped because its tsconfig lists more files than the worker heap can hold.',
          );
        }
        return (request.definitions ?? []).map((definition) => [
          definition.symbolId,
          [{ symbol: 'x', file: 'src/x.ts', line: 0 }],
        ]);
      },
    };
    try {
      const provider = createServiceBackedTypeScriptProvider(db, undefined, { requester });
      const definition = {
        symbolId: 1,
        symbol: 'sym1',
        relativePath: 'src/a.ts',
        documentId: 1,
        startLine: 0,
        startChar: 0,
        endLine: 2,
        endChar: 1,
        leaf: 'a',
        parentTypeName: null,
        isFunctionLike: true,
        isTypeLike: false,
        kind: SymbolInformation_Kind.Function,
        documentation: null,
        enclosingSymbol: null,
      };
      expect(provider.referencesForDefinitions?.([definition])?.size ?? 0).toBe(0);
      // The service stays in use for per-file answers after the decline.
      expect([...(provider.calleesForDefinitions?.([definition])?.keys() ?? [])]).toEqual([1]);
      expect(kinds).toContain('callees');
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('keeps the direct compiler fallback below the large index thresholds', () => {
    const { db } = fixture(3);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const provider = createServiceBackedTypeScriptProvider(db);
      // The direct provider answers availability itself; whatever it says,
      // the service decline path was not taken.
      const availability = provider.availability();
      expect(availability.reason ?? '').not.toContain('declined');
      expect(stderr).not.toHaveBeenCalled();
      provider.dispose?.();
    } finally {
      db.close();
    }
  });
});
