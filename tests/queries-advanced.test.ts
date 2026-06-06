import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScipDatabase } from '../src/storage/db.js';
import * as queries from '../src/queries/index.js';
import { findFirstSymbolMatch } from '../src/symbols/symbol-lookup.js';
import { findEnclosingDefinition, getDefinitionsForFile } from '../src/symbols/definition-catalog.js';
import { getResolvedReferenceSites } from '../src/symbols/reference-graph.js';
import { getSourceReferenceSites } from '../src/symbols/identifier-attribution.js';
import { shortenSymbol } from '../src/symbols/symbol-parser.js';
import type { ScipQueryConfig } from '../src/domain/types.js';
import { advancedFixture, createAdvancedFixtureDb } from './advanced-fixture.js';

function shortNames(items: readonly { shortName: string }[]): string[] {
  return items.map((item) => item.shortName);
}

function hasPair(
  results: readonly { fileA: string; fileB: string }[],
  first: string,
  second: string,
): boolean {
  return results.some(
    (result) =>
      (result.fileA === first && result.fileB === second) ||
      (result.fileA === second && result.fileB === first),
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

  it('finds structural drift across layers and unique deps', () => {
    const summary = queries.drift(db);

    expect(summary.results.length).toBeGreaterThan(0);
    expect(summary.layerViolations).toBeGreaterThan(0);
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
          result.kind === 'layer-violation' &&
          result.file === advancedFixture.files.controller &&
          result.dep === advancedFixture.files.http,
      ),
    ).toBe(true);
  });

  it('honors the minimum sibling threshold for pattern deviations', () => {
    const summary = queries.drift(db, { minDeviation: 6 });

    expect(summary.patternDeviations).toBe(0);
    expect(summary.layerViolations).toBeGreaterThan(0);
  });

  it('reports dataflow through definition, usage, producer, and consumer sites', () => {
    const result = queries.dataflow(db, 'process');

    expect(result).not.toBeNull();
    expect(result!.symbol).toBe(advancedFixture.symbols.process);
    expect(result!.shortName).toBe('app:service:process()');
    expect(result!.definitionSites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: advancedFixture.files.service }),
      ]),
    );
    expect(shortNames(result!.producers)).toEqual(
      expect.arrayContaining([
        'core:math:add()',
        'core:math:mul()',
        'infra:http:fetchData()',
        'ui:view:render()',
        'shared:utils:normalize()',
      ]),
    );
    expect(result!.usageSites.map((site) => site.file)).toEqual(
      expect.arrayContaining([advancedFixture.files.controller, advancedFixture.files.entry]),
    );
    expect(
      result!.consumers.some((consumer) => consumer.shortName === 'app:controller:handle()'),
    ).toBe(true);
  });

  it('computes backward slices from direct tracked inputs', () => {
    const result = queries.slice(db, 'process', { direction: 'backward' });

    expect(result).not.toBeNull();
    expect(result!.direction).toBe('backward');
    expect(shortNames(result!.connectedSymbols)).toEqual(
      expect.arrayContaining([
        'core:math:add()',
        'core:math:mul()',
        'infra:http:fetchData()',
        'ui:view:render()',
        'shared:utils:normalize()',
        'core:state:State',
      ]),
    );
  });

  it('computes forward slices from downstream consumers', () => {
    const result = queries.slice(db, 'normalize', { direction: 'forward' });

    expect(result).not.toBeNull();
    expect(result!.direction).toBe('forward');
    expect(shortNames(result!.connectedSymbols)).toEqual(
      expect.arrayContaining([
        'app:service:process()',
        'app:service:prepare()',
        'app:controller:handle()',
        'app:entry:start()',
        'core:math:pipeline()',
        'infra:http:fetchData()',
        'ui:view:render()',
      ]),
    );
  });

  it('finds stale abstractions with low cross-file reuse', () => {
    const results = queries.staleAbstractions(db, { minLoc: 1, limit: 20 });
    const state = results.find((result) => result.shortName === 'core:state:State');

    expect(state).toBeDefined();
    expect(state).toMatchObject({
      file: advancedFixture.files.state,
      consumers: 1,
    });
  });

  it('ranks the hot service function as a complexity hotspot', () => {
    const results = queries.complexityHotspots(db, { minLoc: 1, limit: 20 });
    const process = results.find((result) => result.shortName === 'app:service:process()');

    expect(process).toBeDefined();
    expect(process).toMatchObject({
      file: advancedFixture.files.service,
    });
    expect(process!.fanIn).toBeGreaterThanOrEqual(2);
    expect(process!.fanOut).toBeGreaterThanOrEqual(4);
    expect(process!.calleeCount).toBeGreaterThanOrEqual(process!.fanOut);
  });

  it('finds structurally similar files by dependency profile', () => {
    const results = queries.similarFiles(db, {
      minDeps: 3,
      minSimilarity: 0.5,
      limit: 20,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(hasPair(results, advancedFixture.files.service, advancedFixture.files.controller)).toBe(true);

    const pair = results.find(
      (result) =>
        hasPair([result], advancedFixture.files.service, advancedFixture.files.controller),
    );

    expect(pair).toBeDefined();
    expect(pair!.similarity).toBeGreaterThanOrEqual(0.5);
    expect(pair!.sharedDeps).toEqual(
      expect.arrayContaining([
        advancedFixture.files.math,
        advancedFixture.files.http,
        advancedFixture.files.view,
      ]),
    );
  });

  it('forward slice enclosing attribution agrees with findEnclosingDefinition', () => {
    // Regression: forwardSlice's `relationship` string must name an enclosing
    // symbol that the canonical `findEnclosingDefinition` helper would assign
    // for the reference site. This pins the invariant that the forward slice
    // implementation routes enclosing attribution through the same helper
    // every other query uses, so they never drift again.
    const match = findFirstSymbolMatch(db, 'normalize');
    expect(match).not.toBeNull();

    const sourceRefs = getSourceReferenceSites(db, match!);
    const refs = sourceRefs.length > 0 ? sourceRefs : getResolvedReferenceSites(db, match!);
    expect(refs.length).toBeGreaterThan(0);

    const enclosingShortNames = new Set<string>();
    for (const ref of refs) {
      const enclosingSymbol =
        ref.enclosingSymbol ??
        findEnclosingDefinition(getDefinitionsForFile(db, ref.file), ref.line)?.symbol ??
        null;
      if (!enclosingSymbol) continue;
      if (enclosingSymbol === match!.symbol) continue;
      enclosingShortNames.add(shortenSymbol(enclosingSymbol));
    }
    expect(enclosingShortNames.size).toBeGreaterThan(0);

    const result = queries.slice(db, 'normalize', { direction: 'forward' });
    expect(result).not.toBeNull();
    expect(result!.connectedSymbols.length).toBeGreaterThan(0);

    for (const connected of result!.connectedSymbols) {
      expect(
        enclosingShortNames.has(connected.shortName),
        `"${connected.shortName}" should be one of the canonical enclosings: ${Array.from(enclosingShortNames).join(', ')}`,
      ).toBe(true);
      expect(connected.relationship).toContain('references target at ');
    }
  });
});
