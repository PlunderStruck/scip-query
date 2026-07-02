import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScipDatabase } from '../../../src/storage/db.js';
import {
  buildCalleeFingerprintIndex,
  comparePair,
  similarAll,
  trimSameFileSiblingSaturatedCallees,
  type SymbolFingerprint,
} from '../../../src/queries/cleanup/similar.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

// followup #5: callee-fingerprint similarity saturated to 1.0 when two
// same-file functions merely shared a small vocabulary of generic same-file
// helpers (external calibration: Vega, `similar` — fuzzMultipartRawAndSse vs
// fuzzSecondaryApi scored top on 4 shared helpers that 5+ other same-file
// scenario functions also called).

function fingerprint(symbol: string, file: string, callees: readonly string[]): SymbolFingerprint {
  return { symbol, file, callees: new Set(callees), paramCount: 0 };
}

describe('trimSameFileSiblingSaturatedCallees (pure)', () => {
  it('drops a callee shared by >= 5 same-file siblings from every fingerprint in that file', () => {
    const fingerprints = [
      fingerprint('a', 'fuzz.ts', ['shared1', 'shared2', 'shared3', 'shared4', 'onlyA']),
      fingerprint('b', 'fuzz.ts', ['shared1', 'shared2', 'shared3', 'shared4', 'onlyB']),
      fingerprint('c', 'fuzz.ts', ['shared1', 'shared2', 'shared3', 'shared4']),
      fingerprint('d', 'fuzz.ts', ['shared1', 'shared2', 'shared3', 'shared4']),
      fingerprint('e', 'fuzz.ts', ['shared1', 'shared2', 'shared3', 'shared4']),
    ];

    const trimmed = trimSameFileSiblingSaturatedCallees(fingerprints);

    expect(trimmed.find((fp) => fp.symbol === 'a')?.callees).toEqual(new Set(['onlyA']));
    expect(trimmed.find((fp) => fp.symbol === 'b')?.callees).toEqual(new Set(['onlyB']));
    expect(trimmed.find((fp) => fp.symbol === 'c')?.callees).toEqual(new Set());
  });

  it('leaves a callee shared by only 2 same-file siblings untouched', () => {
    const fingerprints = [
      fingerprint('x', 'records.ts', ['validate', 'normalize', 'persist', 'audit']),
      fingerprint('y', 'records.ts', ['validate', 'normalize', 'persist', 'audit']),
    ];

    const trimmed = trimSameFileSiblingSaturatedCallees(fingerprints);

    expect(trimmed).toEqual(fingerprints);
  });

  it('counts siblings per file independently', () => {
    const fingerprints = [
      fingerprint('a', 'fileA.ts', ['shared', 'onlyA']),
      fingerprint('b', 'fileB.ts', ['shared', 'onlyB']),
    ];

    const trimmed = trimSameFileSiblingSaturatedCallees(fingerprints);

    expect(trimmed).toEqual(fingerprints);
  });
});

describe('trim -> index -> compare pipeline (pure)', () => {
  it('drops the saturated fuzz pair from candidacy while a genuine near-duplicate pair still scores high', () => {
    const fuzzNames = [
      'fuzzMultipartRawAndSse',
      'fuzzSecondaryApi',
      'fuzzThirdScenario',
      'fuzzFourthScenario',
      'fuzzFifthScenario',
    ];
    const sharedFuzzHelpers = ['sharedHelperA', 'sharedHelperB', 'sharedHelperC', 'sharedHelperD'];
    const fuzzFingerprints = fuzzNames.map((name) =>
      fingerprint(name, 'fuzz.ts', [...sharedFuzzHelpers, `${name}Unique`]),
    );

    const sharedRecordHelpers = [
      'validateRecordPayload',
      'normalizeRecordFields',
      'persistRecordSnapshot',
      'emitRecordAudit',
    ];
    const recordFingerprints = [
      fingerprint('processRecordVariantOne', 'records.ts', sharedRecordHelpers),
      fingerprint('processRecordVariantTwo', 'records.ts', sharedRecordHelpers),
    ];

    // Padding keeps the corpus large enough for IDF weighting to be
    // meaningful — a corpus of only the pair under test would make its
    // shared callees trivially "ubiquitous" (IDF collapses to 0)
    // regardless of this fix, which would prove nothing.
    const padding = Array.from({ length: 6 }, (_, index) =>
      fingerprint(`padding${index}`, `padding${index}.ts`, [
        `pad${index}A`,
        `pad${index}B`,
        `pad${index}C`,
        `pad${index}D`,
      ]),
    );

    const rawCorpus = [...fuzzFingerprints, ...recordFingerprints, ...padding];
    const trimmedCorpus = trimSameFileSiblingSaturatedCallees(rawCorpus).filter((fp) => fp.callees.size >= 4);

    // Every fuzz fingerprint loses its 4 shared helpers (5 same-file
    // siblings call each one) and is left with only its 1 unique callee —
    // below minCallees, so it's not even a corpus member anymore.
    expect(trimmedCorpus.some((fp) => fuzzNames.includes(fp.symbol))).toBe(false);
    expect(trimmedCorpus.some((fp) => fp.symbol === 'processRecordVariantOne')).toBe(true);
    expect(trimmedCorpus.some((fp) => fp.symbol === 'processRecordVariantTwo')).toBe(true);

    const index = buildCalleeFingerprintIndex(trimmedCorpus);
    const one = index.corpus.find((fp) => fp.symbol === 'processRecordVariantOne')!;
    const two = index.corpus.find((fp) => fp.symbol === 'processRecordVariantTwo')!;

    const result = comparePair(one, two, index.idfWeights, {
      minSimilarity: 0.4,
      requireSignificantShared: 2,
      requireSharedCount: 4,
      medianIdf: index.medianIdf,
    });

    expect(result).not.toBeNull();
    expect(result!.similarity).toBeGreaterThanOrEqual(0.9);
  });
});

describe('similarAll sibling-helper fingerprint saturation (db-backed)', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it('does not report an unrelated pair that only shares generic same-file helpers 5+ siblings also call', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-similar-sibling-'));
    const projectRoot = tempDir;

    // Builds source line-by-line so each function's [startLine, endLine]
    // (0-indexed, inclusive) is known exactly for the `.definition()` rows —
    // productionCallableDefinitions requires a real defn_enclosing_ranges row,
    // not just a global_symbols row.
    class SourceBuilder {
      lines: string[] = [];
      ranges = new Map<string, { startLine: number; endLine: number }>();
      fn(name: string, bodyLines: readonly string[]): this {
        const startLine = this.lines.length;
        this.lines.push(`export function ${name}() {`, ...bodyLines, '}', '');
        this.ranges.set(name, { startLine, endLine: this.lines.length - 2 });
        return this;
      }
      source(): string {
        return this.lines.join('\n');
      }
    }

    const fuzzScenarioNames = [
      'fuzzMultipartRawAndSse',
      'fuzzSecondaryApi',
      'fuzzThirdScenario',
      'fuzzFourthScenario',
      'fuzzFifthScenario',
    ];
    const fuzzBuilder = new SourceBuilder()
      .fn('sharedHelperA', ['  return 1;'])
      .fn('sharedHelperB', ['  return 2;'])
      .fn('sharedHelperC', ['  return 3;'])
      .fn('sharedHelperD', ['  return 4;']);
    for (const name of fuzzScenarioNames) {
      fuzzBuilder.fn(name, [
        '  sharedHelperA();',
        '  sharedHelperB();',
        '  sharedHelperC();',
        '  sharedHelperD();',
        `  return '${name}';`,
      ]);
    }

    // Padding files keep the corpus large enough that `sharedHelperA-D`'s
    // *global* document frequency stays low (positive IDF weight) even
    // though their *same-file* sibling count is saturated — the exact shape
    // of the original false positive: locally ubiquitous, not globally
    // ubiquitous. Without padding, a 5-function corpus where every member
    // shares the same 4 callees also collapses via plain global IDF, which
    // wouldn't discriminate whether this fix (vs. pre-existing IDF alone) is
    // what suppresses the pair.
    const paddingFiles: Record<string, string> = {};
    const paddingBuilders: InstanceType<typeof SourceBuilder>[] = [];
    for (let index = 0; index < 8; index += 1) {
      const paddingBuilder = new SourceBuilder().fn(`paddingScenario${index}`, [
        `  pad${index}A();`,
        `  pad${index}B();`,
        `  pad${index}C();`,
        `  pad${index}D();`,
        `  return ${index};`,
      ]);
      for (const helper of ['A', 'B', 'C', 'D']) paddingBuilder.fn(`pad${index}${helper}`, [`  return ${index};`]);
      paddingBuilders.push(paddingBuilder);
      paddingFiles[`src/padding${index}.ts`] = paddingBuilder.source();
    }

    writeFixtureFiles(projectRoot, { 'src/fuzz.ts': fuzzBuilder.source(), ...paddingFiles });

    const dbPath = join(projectRoot, 'index.db');
    const builder = evidenceFixtureDb(dbPath).document(1, 'typescript', 'src/fuzz.ts');
    let symbolId = 1;
    let definitionId = 1;
    const symbolFor = (name: string): string => `scip-typescript npm fixture 1.0.0 src/fuzz.ts/\`${name}\`().`;
    for (const name of ['sharedHelperA', 'sharedHelperB', 'sharedHelperC', 'sharedHelperD', ...fuzzScenarioNames]) {
      builder.symbol(symbolId, symbolFor(name), name, 12);
      const range = fuzzBuilder.ranges.get(name)!;
      builder.definition(definitionId, 1, symbolId, range.startLine, 0, range.endLine, 1);
      symbolId += 1;
      definitionId += 1;
    }
    for (let index = 0; index < paddingBuilders.length; index += 1) {
      const documentId = 2 + index;
      const file = `src/padding${index}.ts`;
      builder.document(documentId, 'typescript', file);
      const paddingBuilder = paddingBuilders[index]!;
      const names = [
        `paddingScenario${index}`,
        `pad${index}A`,
        `pad${index}B`,
        `pad${index}C`,
        `pad${index}D`,
      ];
      for (const name of names) {
        builder.symbol(symbolId, `scip-typescript npm fixture 1.0.0 ${file}/\`${name}\`().`, name, 12);
        const range = paddingBuilder.ranges.get(name)!;
        builder.definition(definitionId, documentId, symbolId, range.startLine, 0, range.endLine, 1);
        symbolId += 1;
        definitionId += 1;
      }
    }
    builder.write();

    const db = new ScipDatabase({ dbPath, projectRoot, indexPath: join(projectRoot, 'index.scip') });
    try {
      const results = similarAll(db, { minSimilarity: 0.1, limit: 50, minCallees: 4, semantic: false });

      const fuzzPair = results.find(
        (r) =>
          (r.shortNameA.includes('fuzzMultipartRawAndSse') && r.shortNameB.includes('fuzzSecondaryApi')) ||
          (r.shortNameB.includes('fuzzMultipartRawAndSse') && r.shortNameA.includes('fuzzSecondaryApi')),
      );
      expect(fuzzPair).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
