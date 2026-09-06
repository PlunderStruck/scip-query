import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScipDatabase } from '../../../src/storage/db.js';
import * as queries from '../../../src/queries/index.js';
import { findFirstSymbolMatch } from '../../../src/symbols/symbol-lookup.js';
import { referenceEvidenceForSymbol } from '../../../src/symbols/references/reference-sites.js';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import { advancedFixture, createAdvancedFixtureDb } from '../../fixtures/advanced-fixture.js';

function hasPair(results: readonly { fileA: string; fileB: string }[], first: string, second: string): boolean {
  return results.some(
    (result) =>
      (result.fileA === first && result.fileB === second) || (result.fileA === second && result.fileB === first),
  );
}

describe('advanced queries', () => {
  let db: ScipDatabase;
  let tempDir: string;
  let dbPath: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-advanced-'));
    dbPath = join(tempDir, 'index.db');
    createAdvancedFixtureDb(dbPath);
    mkdirSync(join(tempDir, 'app'), { recursive: true });
    writeFileSync(
      join(tempDir, advancedFixture.files.model),
      "import '../infra/http.js';\nexport const model = true;\n",
    );

    const config: ScipQueryConfig = {
      dbPath,
      indexPath: join(tempDir, 'index.scip'),
      projectRoot: tempDir,
      architecture: {
        boundaries: [
          { name: 'app', paths: ['app/**'] },
          { name: 'core', paths: ['core/**'] },
          { name: 'infra', paths: ['infra/**'] },
          { name: 'ui', paths: ['ui/**'] },
          { name: 'shared', paths: ['shared/**'] },
        ],
        allowedDependencies: {
          app: ['core', 'shared', 'ui'],
          core: ['shared'],
          infra: ['shared'],
          ui: ['shared'],
          shared: [],
        },
      },
    };
    db = new ScipDatabase(config);
  });

  afterAll(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('finds declared architecture drift and unique deps', () => {
    // includePatternDeviations: true — 21.2 flipped the default to opt-in
    // (low precision at scale); this test asserts the opted-in behavior.
    const summary = queries.drift(db, { includePatternDeviations: true });

    expect(summary.results.length).toBeGreaterThan(0);
    expect(summary.architectureViolations).toBeGreaterThan(0);
    expect(summary.patternDeviations).toBeGreaterThan(0);
    expect(summary.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: advancedFixture.files.service,
          kind: 'pattern-deviation',
          dep: advancedFixture.files.state,
        }),
      ]),
    );
    expect(
      summary.results.some(
        (result) =>
          result.kind === 'architecture-violation' &&
          result.file === advancedFixture.files.model &&
          result.dep === advancedFixture.files.http,
      ),
    ).toBe(true);
  });

  it('honors the minimum sibling threshold for pattern deviations', () => {
    const summary = queries.drift(db, { minDeviation: 6, includePatternDeviations: true });

    expect(summary.patternDeviations).toBe(0);
    expect(summary.architectureViolations).toBeGreaterThan(0);
  });

  it('does not include pattern deviations by default (21.2: opt-in via --patterns)', () => {
    const summary = queries.drift(db);

    expect(summary.patternDeviations).toBe(0);
    expect(summary.results).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'pattern-deviation' })]),
    );
  });

  it('can skip pattern deviations for health-style drift summaries', () => {
    const publicSummary = queries.drift(db, { includePatternDeviations: true });
    const healthStyleSummary = queries.drift(db, { includePatternDeviations: false });

    expect(publicSummary.patternDeviations).toBeGreaterThan(0);
    expect(healthStyleSummary.patternDeviations).toBe(0);
    expect(healthStyleSummary.results).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'pattern-deviation',
        }),
      ]),
    );
    expect(healthStyleSummary.architectureViolations).toBe(publicSummary.architectureViolations);
    expect(healthStyleSummary.unusedImports).toBe(publicSummary.unusedImports);
  });

  it('caps results with -n/--limit and reports totalResults when truncated (21.2)', () => {
    const full = queries.drift(db, { includePatternDeviations: true });
    const capped = queries.drift(db, { includePatternDeviations: true, limit: 1 });

    expect(full.results.length).toBeGreaterThan(1);
    expect(capped.results).toHaveLength(1);
    expect(capped.totalResults).toBe(full.results.length);
    // Counts describe the full population, not just the shown slice.
    expect(capped.architectureViolations).toBe(full.architectureViolations);
    expect(capped.patternDeviations).toBe(full.patternDeviations);
  });

  it('finds structurally similar files by dependency profile', () => {
    const results = queries.similarFiles(db, {
      minDeps: 3,
      minSimilarity: 0.5,
      limit: 20,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(hasPair(results, advancedFixture.files.service, advancedFixture.files.controller)).toBe(true);

    const pair = results.find((result) =>
      hasPair([result], advancedFixture.files.service, advancedFixture.files.controller),
    );

    expect(pair).toBeDefined();
    expect(pair!.similarity).toBeGreaterThanOrEqual(0.5);
    expect(pair!.sharedDeps).toEqual(
      expect.arrayContaining([advancedFixture.files.math, advancedFixture.files.http, advancedFixture.files.view]),
    );
  });

  it('reference evidence records the selected provenance mode', () => {
    const match = findFirstSymbolMatch(db, 'normalize');
    expect(match).not.toBeNull();

    const evidence = referenceEvidenceForSymbol(db, match!);
    expect(evidence.length).toBeGreaterThan(0);
    expect(new Set(evidence.map((site) => site.provenance))).toEqual(new Set(['scip-reference-chunk']));
  });
});
