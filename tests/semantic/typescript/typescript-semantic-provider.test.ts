import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScipDatabase } from '../../../src/storage/db.js';
import {
  exactSemanticCallerMap,
  semanticCallerMap,
  semanticEvidenceProduct,
  semanticImportUsage,
  semanticSignature,
} from '../../../src/semantic/shared-primitives.js';
import { getAllDefinitions } from '../../../src/symbols/definition-catalog.js';
import { dead, refs, staleAbstractions } from '../../../src/queries/index.js';
import { createEvidenceSchema } from '../../fixtures/evidence-fixture.js';
import {
  assembleReferenceFragments,
  compareReferenceFragmentMaps,
} from '../../../src/semantic/typescript/reference-fragments.js';
import { fingerprintProjectFiles } from '../../../src/reindex/project-files.js';
import { materializeSemanticCalleeCache } from '../../../src/symbols/graph/call-graph-evidence.js';
import { EVIDENCE_DB_FILENAME } from '../../../src/storage/evidence-cache.js';
import { typeScriptSemanticIdentityForFile } from '../../../src/semantic/typescript/semantic-identity-context.js';
import {
  readTypeScriptReferenceFragment,
  TYPESCRIPT_REFERENCE_FRAGMENT_SCHEMA,
} from '../../../src/semantic/typescript/reference-fragment-shadow.js';

function createSemanticFixtureDb(dbPath: string): void {
  const db = new Database(dbPath);
  createEvidenceSchema(db);
  db.exec(`
    INSERT INTO documents (id, language, relative_path) VALUES
      (1, 'typescript', 'src/api.ts'),
      (2, 'typescript', 'src/consumer.ts');

    INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
      (1, 1, 0, 0, 6, X''),
      (2, 2, 0, 0, 8, X'');

    INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES
      (1, 'scip-typescript npm fixture 1.0.0 src/\`api.ts\`/ApiShape#', 'ApiShape', 11, 'interface ApiShape'),
      (2, 'scip-typescript npm fixture 1.0.0 src/\`api.ts\`/AliasShape#', 'AliasShape', 11, 'type AliasShape'),
      (3, 'scip-typescript npm fixture 1.0.0 src/\`api.ts\`/usedHelper().', 'usedHelper', 12, 'function usedHelper(): string'),
      (4, 'scip-typescript npm fixture 1.0.0 src/\`api.ts\`/semanticOnly().', 'semanticOnly', 12, 'function semanticOnly(): string'),
      (5, 'scip-typescript npm fixture 1.0.0 src/\`api.ts\`/defaultHelper().', 'defaultHelper', 12, 'function defaultHelper(): string'),
      (6, 'scip-typescript npm fixture 1.0.0 src/\`api.ts\`/namespaceHelper().', 'namespaceHelper', 12, 'function namespaceHelper(): string');

    INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
      (1, 1, 1, 0, 0, 0, 40),
      (2, 1, 2, 1, 0, 1, 36),
      (3, 1, 3, 2, 0, 2, 50),
      (4, 1, 4, 3, 0, 3, 54),
      (5, 1, 5, 4, 0, 4, 65),
      (6, 1, 6, 5, 0, 5, 60);

    INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
      (1, 1, 1),
      (1, 2, 1),
      (1, 3, 1),
      (1, 4, 1),
      (1, 5, 1),
      (1, 6, 1);
  `);
  db.close();
}

function withSemanticFixture(run: (db: ScipDatabase) => void): void {
  const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-ts-semantic-'));
  const dbPath = join(projectRoot, 'index.db');
  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  writeFileSync(
    join(projectRoot, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Node',
          strict: true,
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(projectRoot, 'src/api.ts'),
    [
      'export interface ApiShape { id: string }',
      'export type AliasShape = { id: string }',
      "export function usedHelper(): string { return 'used'; }",
      "export function semanticOnly(): string { return 'semantic'; }",
      "export default function defaultHelper(): string { return 'default'; }",
      "export function namespaceHelper(): string { return 'namespace'; }",
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(projectRoot, 'src/consumer.ts'),
    [
      "import defaultHelper, { type ApiShape, usedHelper, semanticOnly as renamed } from './api';",
      "import type { AliasShape } from './api';",
      "import * as api from './api';",
      'const value: ApiShape & AliasShape = { id: usedHelper() };',
      'renamed();',
      'defaultHelper();',
      'api.namespaceHelper();',
      'void value;',
      '',
    ].join('\n'),
  );
  createSemanticFixtureDb(dbPath);
  writeFileSync(
    join(projectRoot, 'meta.json'),
    JSON.stringify({
      version: 3,
      status: 'complete',
      fingerprint: {
        version: 2,
        languages: ['typescript'],
        pnpmWorkspaces: false,
        typescriptProjectMode: 'single',
        typescriptProjects: [],
        files: fingerprintProjectFiles(projectRoot),
      },
      indexedLanguages: ['typescript'],
    }),
  );

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

async function withSemanticFixtureAsync(run: (db: ScipDatabase) => Promise<void>): Promise<void> {
  const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-ts-semantic-'));
  const dbPath = join(projectRoot, 'index.db');
  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  writeFileSync(
    join(projectRoot, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Node',
          strict: true,
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(projectRoot, 'src/api.ts'),
    [
      'export interface ApiShape { id: string }',
      'export type AliasShape = { id: string }',
      "export function usedHelper(): string { return 'used'; }",
      "export function semanticOnly(): string { return 'semantic'; }",
      "export default function defaultHelper(): string { return 'default'; }",
      "export function namespaceHelper(): string { return 'namespace'; }",
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(projectRoot, 'src/consumer.ts'),
    [
      "import defaultHelper, { type ApiShape, usedHelper, semanticOnly as renamed } from './api';",
      "import type { AliasShape } from './api';",
      "import * as api from './api';",
      'const value: ApiShape & AliasShape = { id: usedHelper() };',
      'renamed();',
      'defaultHelper();',
      'api.namespaceHelper();',
      'void value;',
      '',
    ].join('\n'),
  );
  createSemanticFixtureDb(dbPath);

  const db = new ScipDatabase({
    dbPath,
    indexPath: join(projectRoot, 'index.scip'),
    projectRoot,
  });
  try {
    await run(db);
  } finally {
    db.close();
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

function createMonorepoSemanticFixtureDb(dbPath: string): void {
  const db = new Database(dbPath);
  createEvidenceSchema(db);
  db.exec(`
    INSERT INTO documents (id, language, relative_path) VALUES
      (1, 'typescript', 'shared/src/contracts/horses.ts'),
      (2, 'typescript', 'shared/src/index.ts'),
      (3, 'typescript', 'backend/src/schemas/horses.ts');

    INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
      (1, 1, 0, 0, 6, X''),
      (2, 2, 0, 0, 1, X''),
      (3, 3, 0, 0, 4, X'');

    INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES
      (1, 'scip-typescript npm @fixture/shared 1.0.0 src/contracts/\`horses.ts\`/CreateHorseInput#', NULL, 11, 'type CreateHorseInput'),
      (2, 'scip-typescript npm @fixture/shared 1.0.0 src/contracts/\`horses.ts\`/InternalHorseInput#', NULL, 11, 'type InternalHorseInput');

    INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
      (1, 1, 1, 0, 0, 5, 2),
      (2, 1, 2, 7, 0, 7, 47);

    INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
      (1, 1, 1),
      (1, 2, 1),
      (2, 1, 2);
  `);
  db.close();
}

function withMonorepoSemanticFixture(run: (db: ScipDatabase) => void): void {
  const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-ts-monorepo-semantic-'));
  const dbPath = join(projectRoot, 'index.db');
  mkdirSync(join(projectRoot, 'shared/src/contracts'), { recursive: true });
  mkdirSync(join(projectRoot, 'backend/src/schemas'), { recursive: true });
  writeFileSync(
    join(projectRoot, 'package.json'),
    JSON.stringify(
      {
        private: true,
        workspaces: ['shared', 'backend'],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(projectRoot, 'shared/package.json'),
    JSON.stringify(
      {
        name: '@fixture/shared',
        private: true,
        types: 'dist/index.d.ts',
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(projectRoot, 'backend/package.json'),
    JSON.stringify(
      {
        name: '@fixture/backend',
        private: true,
        dependencies: {
          '@fixture/shared': 'file:../shared',
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(projectRoot, 'shared/tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'CommonJS',
          declaration: true,
          strict: true,
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(projectRoot, 'backend/tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'CommonJS',
          moduleResolution: 'Node',
          strict: true,
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(projectRoot, 'shared/src/contracts/horses.ts'),
    [
      'export type CreateHorseInput = {',
      '  name: string;',
      '  breed?: string;',
      '  ageYears?: number;',
      '  notes?: string;',
      '};',
      '',
      'export type InternalHorseInput = { hidden: string };',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(projectRoot, 'shared/src/index.ts'),
    "export type { CreateHorseInput as PublicHorseInput } from './contracts/horses';\n",
  );
  writeFileSync(
    join(projectRoot, 'backend/src/schemas/horses.ts'),
    [
      "import type { InternalHorseInput, PublicHorseInput } from '@fixture/shared';",
      '',
      'export type SchemaInput = PublicHorseInput & { stableId: string };',
      'export type ShouldNotResolve = InternalHorseInput & { stableId: string };',
      'export const schemaName = "horse";',
      '',
    ].join('\n'),
  );
  createMonorepoSemanticFixtureDb(dbPath);

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

describe('TypeScript semantic provider', () => {
  it('compares tsserver-style reference answers against the ts-morph baseline without changing defaults', async () => {
    await withSemanticFixtureAsync(async (db) => {
      const { createTsMorphProvider } = await import('../../../src/semantic/typescript/ts-morph-provider.js');
      const { compareTypeScriptReferenceProviders, createTsServerProvider } =
        await import('../../../src/semantic/typescript/tsserver-provider.js');
      const definitions = getAllDefinitions(db).filter((definition) =>
        ['usedHelper', 'semanticOnly', 'defaultHelper', 'namespaceHelper'].includes(definition.leaf),
      );

      const baseline = createTsMorphProvider(db);
      const candidate = createTsServerProvider(db);
      const comparison = compareTypeScriptReferenceProviders(definitions, baseline, candidate);

      expect(candidate.availability().available).toBe(true);
      expect(comparison).toMatchObject({
        slot: 'semantic-references',
        definitions: 4,
        matches: 4,
        mismatchCount: 0,
        missingReferenceCount: 0,
        extraReferenceCount: 0,
        mismatches: [],
      });
      expect(comparison.baselineReferenceCount).toBeGreaterThan(0);
      expect(comparison.candidateReferenceCount).toBe(comparison.baselineReferenceCount);
      expect(comparison.baselineMs).toBeGreaterThanOrEqual(0);
      expect(comparison.candidateMs).toBeGreaterThanOrEqual(0);

      const expected = baseline.referencesForDefinitions!(definitions);
      const fragments = baseline.referenceFragmentsForFiles!(['src/api.ts', 'src/consumer.ts']);
      expect(
        compareReferenceFragmentMaps(definitions, expected, assembleReferenceFragments(definitions, fragments)),
      ).toEqual(expect.objectContaining({ passed: true, missing: [], extra: [] }));
    });
  });

  it('uses ts-morph import usage and references as shared liveness evidence', () => {
    withSemanticFixture((db) => {
      const semantic = semanticEvidenceProduct(db);
      const imports = semanticImportUsage(db, 'src/consumer.ts');
      expect(semantic.capability('semantic-import-usage', 'src/consumer.ts')).toEqual(
        expect.objectContaining({
          available: true,
          language: 'typescript',
          slot: 'semantic-import-usage',
        }),
      );
      expect(semantic.capability('semantic-references', 'README.md')).toEqual(
        expect.objectContaining({
          available: false,
          language: 'typescript',
          reason: expect.stringContaining('TypeScript'),
          slot: 'semantic-references',
        }),
      );
      expect(semantic.importUsage('src/consumer.ts')).toEqual(imports);
      expect(
        imports.map((entry) => ({
          localName: entry.localName,
          sourcePath: entry.sourcePath,
          isTypeOnly: entry.isTypeOnly,
          isUsed: entry.isUsed,
        })),
      ).toEqual(
        expect.arrayContaining([
          { localName: 'ApiShape', sourcePath: 'src/api.ts', isTypeOnly: true, isUsed: true },
          { localName: 'AliasShape', sourcePath: 'src/api.ts', isTypeOnly: true, isUsed: true },
          { localName: 'defaultHelper', sourcePath: 'src/api.ts', isTypeOnly: false, isUsed: true },
          { localName: 'usedHelper', sourcePath: 'src/api.ts', isTypeOnly: false, isUsed: true },
          { localName: 'renamed', sourcePath: 'src/api.ts', isTypeOnly: false, isUsed: true },
          { localName: 'api', sourcePath: 'src/api.ts', isTypeOnly: false, isUsed: true },
        ]),
      );

      const definitions = getAllDefinitions(db);
      const referenceMaterialization = semantic.materializeReferences(definitions);
      expect(referenceMaterialization).toEqual(
        expect.objectContaining({
          definitions: definitions.length,
          fragmentDefinitions: definitions.length,
          fragmentCacheHits: 0,
          fragmentCacheMisses: 2,
          fragmentComputedFiles: 2,
          misses: 0,
          unkeyed: 0,
        }),
      );
      const callerMap = semanticCallerMap(db, definitions);
      const exactCallerMap = exactSemanticCallerMap(db, definitions);
      const byName = new Map(definitions.map((definition) => [definition.leaf, definition]));
      expect(semantic.callerMap(definitions)).toEqual(callerMap);
      expect(exactCallerMap.get(byName.get('usedHelper')!.symbolId)).toEqual(new Set(['src/consumer.ts']));
      expect(exactCallerMap.get(byName.get('semanticOnly')!.symbolId)).toEqual(new Set(['src/consumer.ts']));
      expect(callerMap.get(byName.get('usedHelper')!.symbolId)).toEqual(new Set(['src/consumer.ts']));
      expect(callerMap.get(byName.get('semanticOnly')!.symbolId)).toEqual(new Set(['src/consumer.ts']));
      expect(callerMap.get(byName.get('defaultHelper')!.symbolId)).toEqual(new Set(['src/consumer.ts']));
      expect(callerMap.get(byName.get('namespaceHelper')!.symbolId)).toEqual(new Set(['src/consumer.ts']));

      const fragmentIdentity = typeScriptSemanticIdentityForFile(
        db,
        'src/consumer.ts',
        TYPESCRIPT_REFERENCE_FRAGMENT_SCHEMA,
      );
      expect(fragmentIdentity?.key).toEqual(expect.any(String));
      expect(readTypeScriptReferenceFragment(db, 'src/consumer.ts', fragmentIdentity!.key!)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            targetSymbol: byName.get('usedHelper')!.symbol,
            location: expect.objectContaining({ file: 'src/consumer.ts' }),
          }),
        ]),
      );

      expect(semanticSignature(db, byName.get('usedHelper')!)).toBe('()=>string');
      expect(semantic.signature(byName.get('usedHelper')!)).toBe('()=>string');
      const callees = materializeSemanticCalleeCache(db, definitions);

      const evidencePath = join(db.config.projectRoot, EVIDENCE_DB_FILENAME);
      const cacheRows = (): Array<{ cache_key: string; rowid: number }> => {
        const evidence = new Database(evidencePath, { readonly: true });
        try {
          return evidence
            .prepare(
              `SELECT 'file:' || kind || ':' || relative_path AS cache_key, rowid
               FROM file_evidence
               WHERE kind IN ('typescript-reference-fragments', 'typescript-import-usage', 'typescript-signatures')
               UNION ALL
               SELECT 'callee:' || relative_path || ':' || symbol AS cache_key, rowid
               FROM semantic_callees
               ORDER BY cache_key`,
            )
            .all() as Array<{ cache_key: string; rowid: number }>;
        } finally {
          evidence.close();
        }
      };
      const beforeFreshProcess = cacheRows();
      expect(beforeFreshProcess.length).toBeGreaterThanOrEqual(6);

      const freshDb = new ScipDatabase({
        dbPath: db.config.dbPath,
        indexPath: db.config.indexPath,
        projectRoot: db.config.projectRoot,
      });
      try {
        const freshDefinitions = getAllDefinitions(freshDb);
        const freshByName = new Map(freshDefinitions.map((definition) => [definition.leaf, definition]));
        expect(semanticImportUsage(freshDb, 'src/consumer.ts')).toEqual(imports);
        expect(semanticSignature(freshDb, freshByName.get('usedHelper')!)).toBe('()=>string');
        expect(semanticCallerMap(freshDb, freshDefinitions)).toEqual(callerMap);
        expect(materializeSemanticCalleeCache(freshDb, freshDefinitions)).toEqual(callees);
      } finally {
        freshDb.close();
      }
      expect(cacheRows()).toEqual(beforeFreshProcess);

      const consumerPath = join(db.config.projectRoot, 'src/consumer.ts');
      writeFileSync(consumerPath, `${readFileSync(consumerPath, 'utf8')}// ordinary leaf edit\n`);
      writeFileSync(
        join(db.config.projectRoot, 'meta.json'),
        JSON.stringify({
          version: 3,
          status: 'complete',
          fingerprint: {
            version: 2,
            languages: ['typescript'],
            pnpmWorkspaces: false,
            typescriptProjectMode: 'single',
            typescriptProjects: [],
            files: fingerprintProjectFiles(db.config.projectRoot),
          },
          indexedLanguages: ['typescript'],
        }),
      );
      const editedDb = new ScipDatabase({
        dbPath: db.config.dbPath,
        indexPath: db.config.indexPath,
        projectRoot: db.config.projectRoot,
      });
      try {
        const editedMaterialization = semanticEvidenceProduct(editedDb).materializeReferences(
          getAllDefinitions(editedDb),
        );
        expect(editedMaterialization).toEqual(
          expect.objectContaining({
            fragmentCacheHits: 1,
            fragmentCacheMisses: 1,
            fragmentComputedFiles: 1,
          }),
        );
      } finally {
        editedDb.close();
      }
      const afterLeafEdit = cacheRows();
      const rowId = (rows: Array<{ cache_key: string; rowid: number }>, key: string): number | undefined =>
        rows.find((row) => row.cache_key === key)?.rowid;
      expect(rowId(afterLeafEdit, 'file:typescript-reference-fragments:src/api.ts')).toBe(
        rowId(beforeFreshProcess, 'file:typescript-reference-fragments:src/api.ts'),
      );
      expect(rowId(afterLeafEdit, 'file:typescript-reference-fragments:src/consumer.ts')).not.toBe(
        rowId(beforeFreshProcess, 'file:typescript-reference-fragments:src/consumer.ts'),
      );

      expect(dead(db, { minLoc: 1 }).symbols.map((symbol) => symbol.shortName)).not.toContain('api:usedHelper()');
      expect(dead(db, { minLoc: 1 }).symbols.map((symbol) => symbol.shortName)).not.toContain('api:semanticOnly()');
      expect(dead(db, { minLoc: 1 }).symbols.map((symbol) => symbol.shortName)).not.toContain('api:defaultHelper()');
      expect(dead(db, { minLoc: 1 }).symbols.map((symbol) => symbol.shortName)).not.toContain('api:namespaceHelper()');
      expect(staleAbstractions(db, { minLoc: 1 }).map((symbol) => symbol.shortName)).not.toContain('api:ApiShape');
      expect(staleAbstractions(db, { minLoc: 1 }).map((symbol) => symbol.shortName)).not.toContain('api:AliasShape');
    });
  });

  it('uses workspace package imports as cross-project semantic references', () => {
    withMonorepoSemanticFixture((db) => {
      const definitions = getAllDefinitions(db);
      const byName = new Map(definitions.map((definition) => [definition.leaf, definition]));
      const publicDefinition = byName.get('CreateHorseInput')!;
      const internalDefinition = byName.get('InternalHorseInput')!;
      const callerMap = semanticCallerMap(db, [publicDefinition, internalDefinition]);
      expect(callerMap.get(publicDefinition.symbolId)).toEqual(
        new Set(['shared/src/index.ts', 'backend/src/schemas/horses.ts']),
      );
      expect(callerMap.get(internalDefinition.symbolId)).toBeUndefined();

      expect(refs(db, 'CreateHorseInput').map((ref) => ref.relativePath)).toEqual(
        expect.arrayContaining(['shared/src/index.ts', 'backend/src/schemas/horses.ts']),
      );
      expect(staleAbstractions(db, { minLoc: 1 }).map((symbol) => symbol.shortName)).not.toContain(
        'contracts:horses:CreateHorseInput',
      );
    });
  });
});
