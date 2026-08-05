import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import { entryCallMap, entryPoints } from '../../../src/queries/index.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { advancedFixture, createAdvancedFixtureDb } from '../../fixtures/advanced-fixture.js';

describe('entry-rooted call maps', () => {
  let db: ScipDatabase;
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-entry-map-'));
    const dbPath = join(tempDir, 'index.db');
    createAdvancedFixtureDb(dbPath);
    const config: ScipQueryConfig = {
      dbPath,
      indexPath: join(tempDir, 'index.scip'),
      projectRoot: tempDir,
    };
    db = new ScipDatabase(config);
  });

  afterAll(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('finds an uncalled callable on an entry surface without configuration', () => {
    const results = entryPoints(db);
    const start = results.find((result) => result.symbol === advancedFixture.symbols.start);

    expect(start).toMatchObject({
      file: advancedFixture.files.entry,
      confidence: 'candidate',
      indexedCallerCount: 0,
      evidence: ['entry-surface-without-indexed-caller'],
    });
    expect(results.some((result) => result.symbol === advancedFixture.symbols.process)).toBe(false);
  });

  it('searches detected entry-point evidence without interpreting intent', () => {
    const results = entryPoints(db, { search: 'entry point' });

    expect(results.map((result) => result.symbol)).toContain(advancedFixture.symbols.start);
  });

  it('computes the complete reachable graph and collapses it by file', () => {
    const result = entryCallMap(db, advancedFixture.symbols.start);

    expect(result.kind).toBe('matched');
    if (result.kind !== 'matched') return;
    expect(result.coverage.completeWithinIndexedStaticCallEdges).toBe(true);
    expect(result.coverage.dynamicDispatchRepresented).toBe(false);
    expect(result.regions.map((region) => region.file)).toEqual(
      expect.arrayContaining([
        advancedFixture.files.entry,
        advancedFixture.files.controller,
        advancedFixture.files.service,
        advancedFixture.files.math,
        advancedFixture.files.http,
        advancedFixture.files.view,
        advancedFixture.files.utils,
      ]),
    );
    expect(result.regionEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromFile: advancedFixture.files.entry,
          toFile: advancedFixture.files.controller,
        }),
        expect.objectContaining({
          fromFile: advancedFixture.files.controller,
          toFile: advancedFixture.files.service,
        }),
      ]),
    );
    expect(result.regions.every((region) => region.symbols.length === 0)).toBe(true);
  });

  it('expands several file regions in the same view', () => {
    const entryRegion = `file:${advancedFixture.files.entry}`;
    const serviceRegion = `file:${advancedFixture.files.service}`;
    const result = entryCallMap(db, advancedFixture.symbols.start, {
      expand: [entryRegion, serviceRegion],
    });

    expect(result.kind).toBe('matched');
    if (result.kind !== 'matched') return;
    expect(result.unmatchedExpansions).toEqual([]);
    const expanded = result.regions.filter((region) => region.expanded);
    expect(expanded.map((region) => region.id)).toEqual(expect.arrayContaining([entryRegion, serviceRegion]));
    expect(expanded.every((region) => region.symbols.length > 0)).toBe(true);
    expect(result.regions.filter((region) => !region.expanded).every((region) => region.symbols.length === 0)).toBe(
      true,
    );
  });

  it('refuses to call an ordinary internal callable an entry point', () => {
    const result = entryCallMap(db, advancedFixture.symbols.process);

    expect(result).toMatchObject({
      kind: 'not-entry',
      symbol: advancedFixture.symbols.process,
      file: advancedFixture.files.service,
    });
  });

  it('does not promote a private helper merely because its file is a package surface', () => {
    const packageFixture = openPackageSurfaceFixture('function handle() { return 1; }\n');
    try {
      const results = entryPoints(packageFixture.db);

      expect(results.some((result) => result.symbol === advancedFixture.symbols.handle)).toBe(false);
    } finally {
      packageFixture.close();
    }
  });

  it('recognizes an actual exported callable on a package surface as a root', () => {
    const packageFixture = openPackageSurfaceFixture('export function handle() { return 1; }\n');
    try {
      const result = entryPoints(packageFixture.db).find(
        (candidate) => candidate.symbol === advancedFixture.symbols.handle,
      );

      expect(result).toMatchObject({
        confidence: 'root',
        evidence: ['package-public-export'],
      });
    } finally {
      packageFixture.close();
    }
  });
});

function openPackageSurfaceFixture(source: string): { db: ScipDatabase; close: () => void } {
  const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-entry-package-'));
  const dbPath = join(projectRoot, 'index.db');
  createAdvancedFixtureDb(dbPath);
  mkdirSync(join(projectRoot, 'app'), { recursive: true });
  writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ exports: './app/controller.ts' }));
  writeFileSync(join(projectRoot, advancedFixture.files.controller), source);
  const packageDb = new ScipDatabase({
    dbPath,
    indexPath: join(projectRoot, 'index.scip'),
    projectRoot,
  });
  return {
    db: packageDb,
    close: () => {
      packageDb.close();
      rmSync(projectRoot, { recursive: true, force: true });
    },
  };
}
