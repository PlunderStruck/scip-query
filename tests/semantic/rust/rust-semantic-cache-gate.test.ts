import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SemanticProvider } from '../../../src/semantic/types.js';
import { projectEvidenceFingerprint, readCachedSemanticReferences } from '../../../src/storage/evidence-cache.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

afterEach(() => {
  vi.doUnmock('../../../src/semantic/rust/provider.js');
  vi.resetModules();
});

describe('Rust semantic cache gating', () => {
  it('materializes Rust semantic references for a command batch and reuses them for caller maps', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-rust-materialize-'));
    const dbPath = join(projectRoot, 'index.db');
    writeFixtureFiles(projectRoot, {
      'src/lib.rs': [
        'pub fn compute_total(value: i32) -> i32 {',
        '    value + 1',
        '}',
        '',
        'pub fn format_total(value: i32) -> String {',
        '    value.to_string()',
        '}',
      ],
      'src/consumer.rs': [
        'use crate::{compute_total, format_total};',
        'pub fn run() -> String {',
        '    format_total(compute_total(41))',
        '}',
      ],
    });
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(
      join(projectRoot, 'meta.json'),
      JSON.stringify({ version: 3, status: 'complete', fingerprint: 'rust-materialize', indexedLanguages: ['rust'] }),
    );
    evidenceFixtureDb(dbPath)
      .document(1, 'rust', 'src/lib.rs')
      .document(2, 'rust', 'src/consumer.rs')
      .symbol(1, 'rust-analyzer cargo fixture 0.1.0 src/lib.rs/compute_total().', 'compute_total', 12)
      .symbol(2, 'rust-analyzer cargo fixture 0.1.0 src/lib.rs/format_total().', 'format_total', 12)
      .definition(1, 1, 1, 0, 7, 2, 1)
      .definition(2, 1, 2, 4, 7, 6, 1)
      .chunk(1, 1, 0, 6)
      .mention(1, 1, 1)
      .mention(1, 2, 1)
      .write();

    let referenceCalls = 0;
    const batchSizes: number[] = [];
    const fakeRustProvider: SemanticProvider = {
      language: 'rust',
      availability: () => ({
        available: true,
        dependencyAvailable: true,
        resolvedBinary: 'rust-analyzer',
        reason: 'fixture Rust references available',
      }),
      importUsage: () => [],
      referencesFor: () => {
        referenceCalls += 1;
        return [{ file: 'src/consumer.rs', line: 2, column: 4 }];
      },
      referencesForDefinitions: (definitions) => {
        referenceCalls += 1;
        batchSizes.push(definitions.length);
        return new Map(
          definitions.map((definition) => [definition.symbolId, [{ file: 'src/consumer.rs', line: 2, column: 4 }]]),
        );
      },
      calleesFor: () => [],
      calleesForDefinitions: (definitions) => new Map(definitions.map((definition) => [definition.symbolId, []])),
      signatureFor: () => null,
    };
    vi.doMock('../../../src/semantic/rust/provider.js', () => ({
      createRustSemanticProvider: () => fakeRustProvider,
    }));

    const { getAllDefinitions } = await import('../../../src/symbols/definition-catalog.js');
    const { semanticEvidenceProduct } = await import('../../../src/semantic/shared-primitives.js');
    const db = new ScipDatabase({
      dbPath,
      indexPath: join(projectRoot, 'index.scip'),
      projectRoot,
    });

    try {
      const definitions = getAllDefinitions(db);
      expect(definitions).toHaveLength(2);

      const semantic = semanticEvidenceProduct(db);
      const materialized = semantic.materializeReferences(definitions);
      const callerMap = semantic.callerMap([definitions[0]!]);

      expect(materialized).toMatchObject({
        definitions: 2,
        cacheHits: 0,
        misses: 2,
        cacheWrites: 2,
      });
      expect(callerMap.get(definitions[0]!.symbolId)).toEqual(new Set(['src/consumer.rs']));
      expect(batchSizes).toEqual([2]);
      expect(referenceCalls).toBe(1);
    } finally {
      db.close();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('persists Rust semantic references in a Rust-specific cache namespace and reuses them', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-rust-cache-gate-'));
    const dbPath = join(projectRoot, 'index.db');
    writeFixtureFiles(projectRoot, {
      'src/lib.rs': ['pub fn compute_total(value: i32) -> i32 {', '    value + 1', '}'],
      'src/consumer.rs': ['use crate::compute_total;', 'pub fn run() -> i32 {', '    compute_total(41)', '}'],
    });
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(
      join(projectRoot, 'meta.json'),
      JSON.stringify({ version: 3, status: 'complete', fingerprint: 'rust-cache-gate', indexedLanguages: ['rust'] }),
    );
    evidenceFixtureDb(dbPath)
      .document(1, 'rust', 'src/lib.rs')
      .document(2, 'rust', 'src/consumer.rs')
      .symbol(1, 'rust-analyzer cargo fixture 0.1.0 src/lib.rs/compute_total().', 'compute_total', 12)
      .definition(1, 1, 1, 0, 7, 2, 1)
      .chunk(1, 1, 0, 2)
      .mention(1, 1, 1)
      .write();

    let referenceCalls = 0;
    const fakeRustProvider: SemanticProvider = {
      language: 'rust',
      availability: () => ({
        available: true,
        dependencyAvailable: true,
        resolvedBinary: 'rust-analyzer',
        reason: 'fixture Rust references available',
      }),
      importUsage: () => [],
      referencesFor: () => {
        referenceCalls += 1;
        return [{ file: 'src/consumer.rs', line: 2, column: 4 }];
      },
      referencesForDefinitions: (definitions) => {
        referenceCalls += 1;
        return new Map(
          definitions.map((definition) => [definition.symbolId, [{ file: 'src/consumer.rs', line: 2, column: 4 }]]),
        );
      },
      calleesFor: () => [],
      calleesForDefinitions: (definitions) => new Map(definitions.map((definition) => [definition.symbolId, []])),
      signatureFor: () => null,
    };
    vi.doMock('../../../src/semantic/rust/provider.js', () => ({
      createRustSemanticProvider: () => fakeRustProvider,
    }));

    const { getAllDefinitions } = await import('../../../src/symbols/definition-catalog.js');
    const { semanticCallerMap } = await import('../../../src/semantic/shared-primitives.js');
    const db = new ScipDatabase({
      dbPath,
      indexPath: join(projectRoot, 'index.scip'),
      projectRoot,
    });

    try {
      const [definition] = getAllDefinitions(db);
      expect(definition).toBeDefined();

      const callerMap = semanticCallerMap(db, [definition!]);
      const cachedCallerMap = semanticCallerMap(db, [definition!]);
      const fingerprint = projectEvidenceFingerprint(db);

      expect(callerMap.get(definition!.symbolId)).toEqual(new Set(['src/consumer.rs']));
      expect(cachedCallerMap.get(definition!.symbolId)).toEqual(new Set(['src/consumer.rs']));
      expect(referenceCalls).toBe(1);
      expect(fingerprint).not.toBeNull();
      expect(readCachedSemanticReferences(db, definition!.relativePath, definition!.symbol, fingerprint!)).toBeNull();
    } finally {
      db.close();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('persists Rust semantic import usage and reuses it without the provider', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-rust-import-cache-'));
    const dbPath = join(projectRoot, 'index.db');
    writeFixtureFiles(projectRoot, {
      'src/lib.rs': ['mod api;', 'use crate::api::Api;', 'pub fn run(api: Api) {', '    api.run()', '}'],
      'src/api.rs': ['pub struct Api;', 'impl Api { pub fn run(&self) {} }'],
    });
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(
      join(projectRoot, 'meta.json'),
      JSON.stringify({ version: 3, status: 'complete', fingerprint: 'rust-import-cache', indexedLanguages: ['rust'] }),
    );
    evidenceFixtureDb(dbPath).document(1, 'rust', 'src/lib.rs').document(2, 'rust', 'src/api.rs').write();

    let importCalls = 0;
    const importUsage = [
      {
        importer: 'src/lib.rs',
        sourcePath: 'src/api.rs',
        importedName: 'Api',
        localName: 'Api',
        kind: 'named' as const,
        isTypeOnly: false,
        isUsed: true,
        isTypeUsed: false,
        isValueUsed: true,
        references: [{ file: 'src/lib.rs', line: 2, column: 12 }],
      },
    ];
    const fakeRustProvider: SemanticProvider = {
      language: 'rust',
      availability: () => ({
        available: true,
        dependencyAvailable: true,
        resolvedBinary: 'rust-analyzer',
        reason: 'fixture Rust imports available',
      }),
      importUsage: () => {
        importCalls += 1;
        return importUsage;
      },
      referencesFor: () => [],
      referencesForDefinitions: (definitions) => new Map(definitions.map((definition) => [definition.symbolId, []])),
      calleesFor: () => [],
      calleesForDefinitions: (definitions) => new Map(definitions.map((definition) => [definition.symbolId, []])),
      signatureFor: () => null,
    };
    vi.doMock('../../../src/semantic/rust/provider.js', () => ({
      createRustSemanticProvider: () => fakeRustProvider,
    }));

    const { semanticEvidenceProduct } = await import('../../../src/semantic/shared-primitives.js');
    const db1 = new ScipDatabase({
      dbPath,
      indexPath: join(projectRoot, 'index.scip'),
      projectRoot,
    });
    try {
      expect(semanticEvidenceProduct(db1).importUsage('src/lib.rs')).toEqual(importUsage);
    } finally {
      db1.close();
    }

    const db2 = new ScipDatabase({
      dbPath,
      indexPath: join(projectRoot, 'index.scip'),
      projectRoot,
    });
    try {
      expect(semanticEvidenceProduct(db2).importUsage('src/lib.rs')).toEqual(importUsage);
      expect(importCalls).toBe(1);
    } finally {
      db2.close();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('persists Rust semantic signatures, including provider misses', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-rust-signature-cache-'));
    const dbPath = join(projectRoot, 'index.db');
    writeFixtureFiles(projectRoot, {
      'src/lib.rs': ['pub fn run() -> i32 {', '    42', '}'],
    });
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(
      join(projectRoot, 'meta.json'),
      JSON.stringify({
        version: 3,
        status: 'complete',
        fingerprint: 'rust-signature-cache',
        indexedLanguages: ['rust'],
      }),
    );
    evidenceFixtureDb(dbPath)
      .document(1, 'rust', 'src/lib.rs')
      .symbol(1, 'rust-analyzer cargo fixture 0.1.0 src/lib.rs/run().', 'run', 12)
      .definition(1, 1, 1, 0, 7, 2, 1)
      .chunk(1, 1, 0, 2)
      .mention(1, 1, 1)
      .write();

    let signatureCalls = 0;
    const fakeRustProvider: SemanticProvider = {
      language: 'rust',
      availability: () => ({
        available: true,
        dependencyAvailable: true,
        resolvedBinary: 'rust-analyzer',
        reason: 'fixture Rust signatures available',
      }),
      importUsage: () => [],
      referencesFor: () => [],
      referencesForDefinitions: (definitions) => new Map(definitions.map((definition) => [definition.symbolId, []])),
      calleesFor: () => [],
      calleesForDefinitions: (definitions) => new Map(definitions.map((definition) => [definition.symbolId, []])),
      signatureFor: () => {
        signatureCalls += 1;
        return null;
      },
    };
    vi.doMock('../../../src/semantic/rust/provider.js', () => ({
      createRustSemanticProvider: () => fakeRustProvider,
    }));

    const { getAllDefinitions } = await import('../../../src/symbols/definition-catalog.js');
    const { semanticEvidenceProduct } = await import('../../../src/semantic/shared-primitives.js');
    const db1 = new ScipDatabase({
      dbPath,
      indexPath: join(projectRoot, 'index.scip'),
      projectRoot,
    });
    try {
      const [definition] = getAllDefinitions(db1);
      expect(definition).toBeDefined();
      expect(semanticEvidenceProduct(db1).signature(definition!)).toBeNull();
    } finally {
      db1.close();
    }

    const db2 = new ScipDatabase({
      dbPath,
      indexPath: join(projectRoot, 'index.scip'),
      projectRoot,
    });
    try {
      const [definition] = getAllDefinitions(db2);
      expect(definition).toBeDefined();
      expect(semanticEvidenceProduct(db2).signature(definition!)).toBeNull();
      expect(signatureCalls).toBe(1);
    } finally {
      db2.close();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
