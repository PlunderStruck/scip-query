import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IndexedDefinition } from '../../../src/domain/types.js';
import { getSemanticProvider } from '../../../src/semantic/provider-cache.js';
import {
  rustImportUsageFactsFromSource,
  rustImportUsageFromSource,
  rustImportUsageWithResolvedDefinitions,
} from '../../../src/semantic/rust/import-usage.js';
import { createRustSemanticProvider } from '../../../src/semantic/rust/provider.js';
import { semanticEvidenceProduct } from '../../../src/semantic/shared-primitives.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { createEvidenceSchema } from '../../fixtures/evidence-fixture.js';

function withRustSemanticFixture(run: (db: ScipDatabase) => void): void {
  const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-rust-semantic-'));
  const dbPath = join(projectRoot, 'index.db');
  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  const sqlite = new Database(dbPath);
  createEvidenceSchema(sqlite);
  sqlite.exec(`
    INSERT INTO documents (id, language, relative_path) VALUES
      (1, 'rust', 'src/lib.rs');
  `);
  sqlite.close();

  const db = new ScipDatabase({
    dbPath,
    indexPath: join(projectRoot, 'index.scip'),
    projectRoot,
  });
  try {
    run(db);
  } finally {
    db.close();
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

function rustDefinition(overrides: Partial<IndexedDefinition> = {}): IndexedDefinition {
  return {
    symbolId: 1,
    symbol: 'rust-analyzer cargo fixture 0.1.0 src/lib.rs/compute_total().',
    documentId: 1,
    startLine: 1,
    startChar: 11,
    endLine: 3,
    endChar: 1,
    relativePath: 'src/lib.rs',
    leaf: 'compute_total',
    parentTypeName: null,
    isFunctionLike: true,
    isTypeLike: false,
    kind: 12,
    documentation: null,
    enclosingSymbol: null,
    ...overrides,
  };
}

describe('Rust semantic provider', () => {
  it('selects a Rust provider for Rust source paths and reports dependency-gated readiness', () => {
    withRustSemanticFixture((db) => {
      const provider = getSemanticProvider(db, 'src/lib.rs');
      const capability = semanticEvidenceProduct(db).capability('semantic-references', 'src/lib.rs');

      expect(provider.language).toBe('rust');
      expect(capability.language).toBe('rust');
      expect(capability.available).toBe(capability.dependencyAvailable);
      expect(capability.reason).toMatch(/enabled|not runnable/);
    });
  });

  it('caches Rust analyzer base availability inside a provider instance', () => {
    let statusCalls = 0;
    const definition = rustDefinition();
    const provider = createRustSemanticProvider('/repo', {
      status: () => {
        statusCalls += 1;
        return {
          available: true,
          dependencyAvailable: true,
          resolvedBinary: 'rust-analyzer',
          reason: 'rust-analyzer semantic queries are enabled.',
        };
      },
      referenceResolver: {
        referencesForDefinitions(definitions) {
          return {
            available: true,
            references: new Map(definitions.map((entry) => [entry.symbolId, []])),
          };
        },
      },
    });

    provider.availability();
    provider.availability();
    provider.referencesForDefinitions!([definition]);
    provider.availability();

    expect(statusCalls).toBe(1);
  });

  it('returns bulk Rust references from the injected reference resolver', () => {
    const first = rustDefinition({ symbolId: 1, leaf: 'compute_total' });
    const second = rustDefinition({
      symbolId: 2,
      symbol: 'rust-analyzer cargo fixture 0.1.0 src/lib.rs/format_total().',
      leaf: 'format_total',
      startLine: 5,
      startChar: 11,
    });
    const requested: IndexedDefinition[][] = [];
    const provider = createRustSemanticProvider('/repo', {
      status: () => ({
        available: true,
        dependencyAvailable: true,
        resolvedBinary: 'rust-analyzer',
        reason: 'rust-analyzer semantic reference queries are enabled.',
      }),
      referenceResolver: {
        referencesForDefinitions(definitions) {
          requested.push(definitions);
          return {
            available: true,
            references: new Map([
              [1, [{ file: 'src/consumer.rs', line: 9, column: 5 }]],
              [2, [{ file: 'src/formatter.rs', line: 3, column: 12 }]],
            ]),
          };
        },
      },
    });

    expect(provider.referencesForDefinitions!([first, second])).toEqual(
      new Map([
        [1, [{ file: 'src/consumer.rs', line: 9, column: 5 }]],
        [2, [{ file: 'src/formatter.rs', line: 3, column: 12 }]],
      ]),
    );
    expect(provider.referencesFor(first)).toEqual([{ file: 'src/consumer.rs', line: 9, column: 5 }]);
    expect(requested).toHaveLength(2);
    expect(requested[0]).toEqual([first, second]);
    expect(requested[1]).toEqual([first]);
  });

  it('returns bulk Rust callees from the injected callee resolver', () => {
    const first = rustDefinition({ symbolId: 1, leaf: 'run' });
    const requested: IndexedDefinition[][] = [];
    const provider = createRustSemanticProvider('/repo', {
      status: () => ({
        available: true,
        dependencyAvailable: true,
        resolvedBinary: 'rust-analyzer',
        reason: 'rust-analyzer semantic queries are enabled.',
      }),
      calleeResolver: {
        calleesForDefinitions(definitions) {
          requested.push(definitions);
          return {
            available: true,
            callees: new Map([
              [
                1,
                [
                  {
                    symbol: 'compute_total',
                    file: 'src/math.rs',
                    line: 4,
                  },
                ],
              ],
            ]),
          };
        },
      },
      calleeSymbolResolver: (callee) =>
        callee.symbol === 'compute_total'
          ? 'rust-analyzer cargo fixture 0.1.0 src/math.rs/compute_total().'
          : callee.symbol,
    });

    expect(provider.calleesForDefinitions!([first])).toEqual(
      new Map([
        [
          1,
          [
            {
              symbol: 'rust-analyzer cargo fixture 0.1.0 src/math.rs/compute_total().',
              file: 'src/math.rs',
              line: 4,
            },
          ],
        ],
      ]),
    );
    expect(provider.calleesFor(first)).toEqual([
      {
        symbol: 'rust-analyzer cargo fixture 0.1.0 src/math.rs/compute_total().',
        file: 'src/math.rs',
        line: 4,
      },
    ]);
    expect(requested).toHaveLength(2);
    expect(requested[0]).toEqual([first]);
    expect(requested[1]).toEqual([first]);
  });

  it('prefetches Rust callees during combined reference and callee resolution', () => {
    const referenced = rustDefinition({ symbolId: 1, leaf: 'compute_total' });
    const caller = rustDefinition({
      symbolId: 2,
      symbol: 'rust-analyzer cargo fixture 0.1.0 src/lib.rs/run().',
      leaf: 'run',
      startLine: 5,
      endLine: 9,
    });
    let referenceCalls = 0;
    let calleeCalls = 0;
    const provider = createRustSemanticProvider('/repo', {
      status: () => ({
        available: true,
        dependencyAvailable: true,
        resolvedBinary: 'rust-analyzer',
        reason: 'rust-analyzer semantic queries are enabled.',
      }),
      referenceResolver: {
        referencesForDefinitions(definitions) {
          referenceCalls += 1;
          return {
            available: true,
            references: new Map(
              definitions.map((definition) => [definition.symbolId, [{ file: 'src/main.rs', line: 8, column: 5 }]]),
            ),
          };
        },
      },
      calleeResolver: {
        calleesForDefinitions(definitions) {
          calleeCalls += 1;
          return {
            available: true,
            callees: new Map(
              definitions.map((definition) => [
                definition.symbolId,
                [{ symbol: 'compute_total', file: 'src/math.rs', line: 4 }],
              ]),
            ),
          };
        },
      },
      calleeSymbolResolver: (callee) =>
        callee.symbol === 'compute_total'
          ? 'rust-analyzer cargo fixture 0.1.0 src/math.rs/compute_total().'
          : callee.symbol,
    });

    const combined = provider.referencesAndCalleesForDefinitions!([referenced], [caller]);
    const cachedCallees = provider.calleesForDefinitions!([caller]);

    expect(combined.references).toEqual(new Map([[1, [{ file: 'src/main.rs', line: 8, column: 5 }]]]));
    expect(combined.callees).toEqual(
      new Map([
        [
          2,
          [
            {
              symbol: 'rust-analyzer cargo fixture 0.1.0 src/math.rs/compute_total().',
              file: 'src/math.rs',
              line: 4,
            },
          ],
        ],
      ]),
    );
    expect(cachedCallees).toEqual(combined.callees);
    expect(referenceCalls).toBe(1);
    expect(calleeCalls).toBe(1);
  });

  it('only asks Rust callee resolvers about definitions that can contain callees', () => {
    const callable = rustDefinition({ symbolId: 1, leaf: 'run' });
    const typeDefinition = rustDefinition({
      symbolId: 2,
      symbol: 'rust-analyzer cargo fixture 0.1.0 src/lib.rs/Config#',
      leaf: 'Config',
      isFunctionLike: false,
      isTypeLike: true,
      kind: 23,
    });
    const fieldDefinition = rustDefinition({
      symbolId: 3,
      symbol: 'rust-analyzer cargo fixture 0.1.0 src/lib.rs/Config#enabled.',
      leaf: 'enabled',
      isFunctionLike: false,
      isTypeLike: false,
      kind: 8,
    });
    const requested: IndexedDefinition[][] = [];
    const provider = createRustSemanticProvider('/repo', {
      status: () => ({
        available: true,
        dependencyAvailable: true,
        resolvedBinary: 'rust-analyzer',
        reason: 'rust-analyzer semantic queries are enabled.',
      }),
      calleeResolver: {
        calleesForDefinitions(definitions) {
          requested.push(definitions);
          return {
            available: true,
            callees: new Map([[1, [{ symbol: 'compute_total', file: 'src/math.rs', line: 4 }]]]),
          };
        },
      },
    });

    expect(provider.calleesForDefinitions!([callable, typeDefinition, fieldDefinition])).toEqual(
      new Map([
        [1, [{ symbol: 'compute_total', file: 'src/math.rs', line: 4 }]],
        [2, []],
        [3, []],
      ]),
    );
    expect(requested).toEqual([[callable]]);
  });

  it('skips Rust callee resolver work when source facts prove zero callees', () => {
    const sourceEmpty = rustDefinition({ symbolId: 1, leaf: 'empty_source_body' });
    const needsSemantic = rustDefinition({
      symbolId: 2,
      symbol: 'rust-analyzer cargo fixture 0.1.0 src/lib.rs/run().',
      leaf: 'run',
      startLine: 5,
      endLine: 9,
    });
    const requested: IndexedDefinition[][] = [];
    const provider = createRustSemanticProvider('/repo', {
      status: () => ({
        available: true,
        dependencyAvailable: true,
        resolvedBinary: 'rust-analyzer',
        reason: 'rust-analyzer semantic queries are enabled.',
      }),
      sourceZeroCalleeOracle: (definition) => definition.symbolId === sourceEmpty.symbolId,
      calleeResolver: {
        calleesForDefinitions(definitions) {
          requested.push(definitions);
          return {
            available: true,
            callees: new Map([[needsSemantic.symbolId, [{ symbol: 'compute_total', file: 'src/math.rs', line: 4 }]]]),
          };
        },
      },
    });

    expect(provider.calleesForDefinitions!([sourceEmpty, needsSemantic])).toEqual(
      new Map([
        [sourceEmpty.symbolId, []],
        [needsSemantic.symbolId, [{ symbol: 'compute_total', file: 'src/math.rs', line: 4 }]],
      ]),
    );
    expect(requested).toEqual([[needsSemantic]]);
  });

  it('skips Rust callee resolver work when SCIP occurrences prove positive callees', () => {
    const sourceProven = rustDefinition({ symbolId: 1, leaf: 'source_proven' });
    const needsSemantic = rustDefinition({
      symbolId: 2,
      symbol: 'rust-analyzer cargo fixture 0.1.0 src/lib.rs/run().',
      leaf: 'run',
      startLine: 5,
      endLine: 9,
    });
    const requested: IndexedDefinition[][] = [];
    const provider = createRustSemanticProvider('/repo', {
      status: () => ({
        available: true,
        dependencyAvailable: true,
        resolvedBinary: 'rust-analyzer',
        reason: 'rust-analyzer semantic queries are enabled.',
      }),
      scipOccurrenceCalleeOracle: (definitions) =>
        new Map(
          definitions
            .filter((definition) => definition.symbolId === sourceProven.symbolId)
            .map((definition) => [
              definition.symbolId,
              [
                {
                  symbol: 'rust-analyzer cargo fixture 0.1.0 src/lib.rs/helper().',
                  file: 'src/lib.rs',
                  line: 0,
                },
              ],
            ]),
        ),
      calleeResolver: {
        calleesForDefinitions(definitions) {
          requested.push(definitions);
          return {
            available: true,
            callees: new Map([[needsSemantic.symbolId, [{ symbol: 'compute_total', file: 'src/math.rs', line: 4 }]]]),
          };
        },
      },
    });

    expect(provider.calleesForDefinitions!([sourceProven, needsSemantic])).toEqual(
      new Map([
        [
          sourceProven.symbolId,
          [{ symbol: 'rust-analyzer cargo fixture 0.1.0 src/lib.rs/helper().', file: 'src/lib.rs', line: 0 }],
        ],
        [needsSemantic.symbolId, [{ symbol: 'compute_total', file: 'src/math.rs', line: 4 }]],
      ]),
    );
    expect(requested).toEqual([[needsSemantic]]);
  });

  it('omits source-proven zero-callee definitions from combined Rust semantic requests', () => {
    const sourceEmpty = rustDefinition({ symbolId: 1, leaf: 'empty_source_body' });
    const needsSemantic = rustDefinition({
      symbolId: 2,
      symbol: 'rust-analyzer cargo fixture 0.1.0 src/lib.rs/run().',
      leaf: 'run',
      startLine: 5,
      endLine: 9,
    });
    const requested: IndexedDefinition[][] = [];
    const provider = createRustSemanticProvider('/repo', {
      status: () => ({
        available: true,
        dependencyAvailable: true,
        resolvedBinary: 'rust-analyzer',
        reason: 'rust-analyzer semantic queries are enabled.',
      }),
      sourceZeroCalleeOracle: (definition) => definition.symbolId === sourceEmpty.symbolId,
      calleeResolver: {
        calleesForDefinitions(definitions) {
          requested.push(definitions);
          return {
            available: true,
            callees: new Map([[needsSemantic.symbolId, [{ symbol: 'compute_total', file: 'src/math.rs', line: 4 }]]]),
          };
        },
      },
    });

    const result = provider.referencesAndCalleesForDefinitions!([], [sourceEmpty, needsSemantic]);

    expect(result.callees).toEqual(
      new Map([
        [sourceEmpty.symbolId, []],
        [needsSemantic.symbolId, [{ symbol: 'compute_total', file: 'src/math.rs', line: 4 }]],
      ]),
    );
    expect(requested).toEqual([[needsSemantic]]);
  });

  it('omits SCIP-occurrence-proven callees from combined Rust semantic requests', () => {
    const sourceProven = rustDefinition({ symbolId: 1, leaf: 'source_proven' });
    const needsSemantic = rustDefinition({
      symbolId: 2,
      symbol: 'rust-analyzer cargo fixture 0.1.0 src/lib.rs/run().',
      leaf: 'run',
      startLine: 5,
      endLine: 9,
    });
    const requested: IndexedDefinition[][] = [];
    const provider = createRustSemanticProvider('/repo', {
      status: () => ({
        available: true,
        dependencyAvailable: true,
        resolvedBinary: 'rust-analyzer',
        reason: 'rust-analyzer semantic queries are enabled.',
      }),
      scipOccurrenceCalleeOracle: (definitions) =>
        new Map(
          definitions
            .filter((definition) => definition.symbolId === sourceProven.symbolId)
            .map((definition) => [
              definition.symbolId,
              [
                {
                  symbol: 'rust-analyzer cargo fixture 0.1.0 src/lib.rs/helper().',
                  file: 'src/lib.rs',
                  line: 0,
                },
              ],
            ]),
        ),
      calleeResolver: {
        calleesForDefinitions(definitions) {
          requested.push(definitions);
          return {
            available: true,
            callees: new Map([[needsSemantic.symbolId, [{ symbol: 'compute_total', file: 'src/math.rs', line: 4 }]]]),
          };
        },
      },
    });

    const result = provider.referencesAndCalleesForDefinitions!([], [sourceProven, needsSemantic]);

    expect(result.callees).toEqual(
      new Map([
        [
          sourceProven.symbolId,
          [{ symbol: 'rust-analyzer cargo fixture 0.1.0 src/lib.rs/helper().', file: 'src/lib.rs', line: 0 }],
        ],
        [needsSemantic.symbolId, [{ symbol: 'compute_total', file: 'src/math.rs', line: 4 }]],
      ]),
    );
    expect(requested).toEqual([[needsSemantic]]);
  });

  it('returns SCIP-occurrence-proven callees when no semantic request remains', () => {
    const sourceProven = rustDefinition({ symbolId: 1, leaf: 'source_proven' });
    const provider = createRustSemanticProvider('/repo', {
      status: () => ({
        available: true,
        dependencyAvailable: true,
        resolvedBinary: 'rust-analyzer',
        reason: 'rust-analyzer semantic queries are enabled.',
      }),
      scipOccurrenceCalleeOracle: (definitions) =>
        new Map(
          definitions.map((definition) => [
            definition.symbolId,
            [{ symbol: 'rust-analyzer cargo fixture 0.1.0 src/lib.rs/helper().', file: 'src/lib.rs', line: 0 }],
          ]),
        ),
    });

    const result = provider.referencesAndCalleesForDefinitions!([], [sourceProven]);

    expect(result.callees).toEqual(
      new Map([
        [
          sourceProven.symbolId,
          [{ symbol: 'rust-analyzer cargo fixture 0.1.0 src/lib.rs/helper().', file: 'src/lib.rs', line: 0 }],
        ],
      ]),
    );
  });

  it('returns Rust signatures from the injected signature resolver', () => {
    const definition = rustDefinition({ symbolId: 1, leaf: 'run' });
    const requested: IndexedDefinition[][] = [];
    const provider = createRustSemanticProvider('/repo', {
      status: () => ({
        available: true,
        dependencyAvailable: true,
        resolvedBinary: 'rust-analyzer',
        reason: 'rust-analyzer semantic queries are enabled.',
      }),
      signatureResolver: {
        signaturesForDefinitions(definitions) {
          requested.push(definitions);
          return {
            available: true,
            signatures: new Map([[1, 'pub fn run() -> i32']]),
          };
        },
      },
    });

    expect(provider.signatureFor(definition)).toBe('pub fn run() -> i32');
    expect(requested).toEqual([[definition]]);
  });

  it('returns Rust import usage from the injected import resolver', () => {
    const requested: string[] = [];
    const provider = createRustSemanticProvider('/repo', {
      status: () => ({
        available: true,
        dependencyAvailable: true,
        resolvedBinary: 'rust-analyzer',
        reason: 'rust-analyzer semantic queries are enabled.',
      }),
      importUsageResolver: {
        importUsage(file) {
          requested.push(file);
          return [
            {
              importer: file,
              sourcePath: 'src/math.rs',
              importedName: 'add',
              localName: 'plus',
              kind: 'named',
              isTypeOnly: false,
              isUsed: true,
              isTypeUsed: false,
              isValueUsed: true,
              references: [],
            },
          ];
        },
      },
    });

    expect(provider.importUsage('src/lib.rs')).toEqual([
      {
        importer: 'src/lib.rs',
        sourcePath: 'src/math.rs',
        importedName: 'add',
        localName: 'plus',
        kind: 'named',
        isTypeOnly: false,
        isUsed: true,
        isTypeUsed: false,
        isValueUsed: true,
        references: [],
      },
    ]);
    expect(provider.importUsage('src/lib.rs')).toHaveLength(1);
    expect(requested).toEqual(['src/lib.rs']);
  });

  it('maps Rust use declarations into semantic import usage entries', () => {
    withRustSemanticFixture((db) => {
      writeFileSync(
        join(db.config.projectRoot, 'src/lib.rs'),
        ['use crate::math::{add as plus, unused};', '', 'pub fn run() -> i32 {', '    plus(1, 2)', '}', ''].join('\n'),
      );
      writeFileSync(
        join(db.config.projectRoot, 'src/math.rs'),
        ['pub fn add(left: i32, right: i32) -> i32 { left + right }', 'pub fn unused() -> i32 { 0 }', ''].join('\n'),
      );

      expect(
        rustImportUsageFromSource(db, 'src/lib.rs').map((entry) => ({
          importedName: entry.importedName,
          localName: entry.localName,
          sourcePath: entry.sourcePath,
          isUsed: entry.isUsed,
          isValueUsed: entry.isValueUsed,
        })),
      ).toEqual(
        expect.arrayContaining([
          {
            importedName: 'add',
            localName: 'plus',
            sourcePath: 'src/math.rs',
            isUsed: true,
            isValueUsed: true,
          },
          {
            importedName: 'unused',
            localName: 'unused',
            sourcePath: 'src/math.rs',
            isUsed: false,
            isValueUsed: false,
          },
        ]),
      );
    });
  });

  it('records Rust import definition positions from use declarations', () => {
    withRustSemanticFixture((db) => {
      writeFileSync(
        join(db.config.projectRoot, 'src/lib.rs'),
        ['use crate::math::{add as plus, unused};', '', 'pub fn run() -> i32 {', '    plus(1, 2)', '}', ''].join('\n'),
      );
      writeFileSync(
        join(db.config.projectRoot, 'src/math.rs'),
        ['pub fn add(left: i32, right: i32) -> i32 { left + right }', 'pub fn unused() -> i32 { 0 }', ''].join('\n'),
      );

      const facts = rustImportUsageFactsFromSource(db, 'src/lib.rs');

      expect(
        facts.positions.map((position) => ({
          id: position.id,
          file: position.file,
          line: position.line,
        })),
      ).toEqual([
        { id: '0', file: 'src/lib.rs', line: 0 },
        { id: '1', file: 'src/lib.rs', line: 0 },
      ]);
    });
  });

  it('overlays Rust import source paths with compiler-resolved definitions', () => {
    const usage = [
      {
        importer: 'src/lib.rs',
        sourcePath: 'src/guessed.rs',
        importedName: 'add',
        localName: 'plus',
        kind: 'named' as const,
        isTypeOnly: false,
        isUsed: true,
        isTypeUsed: false,
        isValueUsed: true,
        references: [],
      },
      {
        importer: 'src/lib.rs',
        sourcePath: 'src/source-only.rs',
        importedName: 'unused',
        localName: 'unused',
        kind: 'named' as const,
        isTypeOnly: false,
        isUsed: false,
        isTypeUsed: false,
        isValueUsed: false,
        references: [],
      },
    ];

    expect(rustImportUsageWithResolvedDefinitions(usage, new Map([['0', 'src/math.rs']]))).toEqual([
      {
        ...usage[0],
        sourcePath: 'src/math.rs',
      },
      usage[1],
    ]);
  });

  it('uses compiler-backed Rust import definition paths when the provider has them', () => {
    const provider = createRustSemanticProvider('/repo', {
      status: () => ({
        available: true,
        dependencyAvailable: true,
        resolvedBinary: 'rust-analyzer',
        reason: 'rust-analyzer semantic queries are enabled.',
      }),
      sourceImportUsageResolver: {
        importUsageFacts(file) {
          return {
            usage: [
              {
                importer: file,
                sourcePath: 'src/guessed.rs',
                importedName: 'add',
                localName: 'plus',
                kind: 'named',
                isTypeOnly: false,
                isUsed: true,
                isTypeUsed: false,
                isValueUsed: true,
                references: [],
              },
            ],
            positions: [{ id: '0', file, line: 0, column: 18 }],
          };
        },
      },
      importDefinitionResolver: {
        importDefinitionsForFile(file, positions) {
          return {
            available: true,
            resolvedBinary: 'rust-analyzer',
            sourcePaths: new Map(
              positions.map((position) => [position.id, file === 'src/lib.rs' ? 'src/math.rs' : null]),
            ),
          };
        },
      },
    });

    expect(provider.importUsage('src/lib.rs')).toEqual([
      {
        importer: 'src/lib.rs',
        sourcePath: 'src/math.rs',
        importedName: 'add',
        localName: 'plus',
        kind: 'named',
        isTypeOnly: false,
        isUsed: true,
        isTypeUsed: false,
        isValueUsed: true,
        references: [],
      },
    ]);
  });

  it('hydrates missing Rust definition leaf names before calling the callee resolver', () => {
    const lightweightDefinition = {
      symbolId: 1,
      symbol: 'rust-analyzer cargo fixture 0.1.0 src/lib.rs/run().',
      documentId: 1,
      startLine: 0,
      startChar: 0,
      endLine: 2,
      endChar: 1,
      relativePath: 'src/lib.rs',
    } as IndexedDefinition;
    let requestedLeaf: string | undefined;
    const provider = createRustSemanticProvider('/repo', {
      status: () => ({
        available: true,
        dependencyAvailable: true,
        resolvedBinary: 'rust-analyzer',
        reason: 'rust-analyzer semantic queries are enabled.',
      }),
      calleeResolver: {
        calleesForDefinitions(definitions) {
          requestedLeaf = definitions[0]?.leaf;
          return {
            available: true,
            callees: new Map([[1, []]]),
          };
        },
      },
    });

    provider.calleesForDefinitions!([lightweightDefinition]);

    expect(requestedLeaf).toBe('run');
  });

  it('keeps provider calls non-throwing when rust-analyzer fails', () => {
    const definition = rustDefinition();
    const provider = createRustSemanticProvider('/repo', {
      status: () => ({
        available: true,
        dependencyAvailable: true,
        resolvedBinary: 'rust-analyzer',
        reason: 'rust-analyzer semantic reference queries are enabled.',
      }),
      referenceResolver: {
        referencesForDefinitions() {
          return {
            available: false,
            reason: 'rust-analyzer workspace initialization failed',
            references: new Map(),
          };
        },
      },
    });

    expect(provider.referencesForDefinitions!([definition])).toEqual(new Map([[1, []]]));
    expect(provider.availability()).toEqual(
      expect.objectContaining({
        available: false,
        reason: 'rust-analyzer workspace initialization failed',
      }),
    );
  });
});
