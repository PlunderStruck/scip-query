import { describe, expect, it } from 'vitest';
// The calibration core is an executable-script module and intentionally stays
// as native ESM outside the shipped TypeScript source tree.
// @ts-expect-error native script modules do not ship TypeScript declarations
import {
  applyUtilityGroups,
  applyVerdictGroups,
  calibrationRowIdentity,
  deterministicSample,
  deterministicStratifiedSample,
  normalizeDeadCandidate,
  normalizeFactualCandidate,
  normalizeSimilarityCandidate,
  parseArchitectureCalibrationOptions,
  parseDeadCalibrationOptions,
  parseFactualCalibrationOptions,
  parseGraphRiskCalibrationOptions,
  parseSimilarityCalibrationOptions,
  summarizeCalibration,
  summarizeCalibrationByDetector,
  summarizeUtilityByDetector,
  wilsonInterval,
} from '../../scripts/accuracy-calibration-core.mjs';

interface CalibrationTestRow {
  detector: string;
  language: string;
  repository: string;
  relativePath: string;
  symbol: string;
  startLine: number;
  verdict: 'valid' | 'invalid' | 'uncertain' | null;
}

function row(index: number, overrides: Partial<CalibrationTestRow> = {}): CalibrationTestRow {
  return {
    detector: 'dead',
    language: 'typescript',
    repository: `repo-${index % 4}`,
    relativePath: `src/file-${index}.ts`,
    symbol: `symbol-${index}`,
    startLine: index,
    verdict: 'valid',
    ...overrides,
  };
}

describe('accuracy calibration core', () => {
  it('selects language-specific dead-code defaults without changing TypeScript compatibility', () => {
    const defaults = { typescript: ['/repos/ts'], rust: ['/repos/rust-a', '/repos/rust-b'] };
    expect(parseDeadCalibrationOptions([], defaults)).toEqual({
      language: 'typescript',
      sampleSize: 25,
      seed: 'typescript-dead-v1',
      roots: ['/repos/ts'],
    });
    expect(
      parseDeadCalibrationOptions(['--language', 'rust', '--sample-size', '7', '--seed', 'fixed'], defaults),
    ).toEqual({ language: 'rust', sampleSize: 7, seed: 'fixed', roots: ['/repos/rust-a', '/repos/rust-b'] });
    expect(() => parseDeadCalibrationOptions(['--language', 'python'], defaults)).toThrow('--language must be one of');
  });

  it('selects all TypeScript factual detectors or an explicit repeatable subset', () => {
    const all = parseFactualCalibrationOptions([], ['/repos/a', '/repos/b']);
    expect(all.language).toBe('typescript');
    expect(all.detectors).toContain('unused-imports');
    expect(all.detectors).toContain('test-quality');
    expect(all.roots).toEqual(['/repos/a', '/repos/b']);

    expect(
      parseFactualCalibrationOptions(
        ['--detector', 'cycles', '--detector', 'cycles', '--sample-size', '7', '/repos/custom'],
        ['/repos/default'],
      ),
    ).toMatchObject({ detectors: ['cycles'], sampleSize: 7, roots: ['/repos/custom'] });
  });

  it('selects all TypeScript similarity detectors or an explicit repeatable subset', () => {
    const all = parseSimilarityCalibrationOptions([], ['/repos/a', '/repos/b']);
    expect(all).toMatchObject({
      language: 'typescript',
      seed: 'typescript-similarity-v1',
      roots: ['/repos/a', '/repos/b'],
    });
    expect(all.detectors).toEqual([
      'recent-duplicates',
      'similar',
      'similar-files',
      'similar-chains',
      'similar-signatures',
      'twin-drift',
    ]);
    expect(
      parseSimilarityCalibrationOptions(
        ['--detector', 'similar', '--detector', 'similar', '--sample-size', '4', '/repos/custom'],
        ['/repos/default'],
      ),
    ).toMatchObject({ detectors: ['similar'], sampleSize: 4, roots: ['/repos/custom'] });
  });

  it('selects all TypeScript architecture detectors or an explicit repeatable subset', () => {
    const all = parseArchitectureCalibrationOptions([], ['/repos/a', '/repos/b']);
    expect(all).toMatchObject({
      language: 'typescript',
      seed: 'typescript-architecture-v1',
      roots: ['/repos/a', '/repos/b'],
    });
    expect(all.detectors).toEqual([
      'co-change',
      'doc-drift',
      'drift',
      'wrapper-candidates',
      'passthrough-candidates',
      'stale-abstractions',
    ]);
    expect(
      parseArchitectureCalibrationOptions(
        ['--detector', 'drift', '--detector', 'drift', '--sample-size', '6', '/repos/custom'],
        ['/repos/default'],
      ),
    ).toMatchObject({ detectors: ['drift'], sampleSize: 6, roots: ['/repos/custom'] });
    expect(() => parseArchitectureCalibrationOptions(['--detector', 'similar'], ['/repos/default'])).toThrow(
      '--detector must be one of',
    );
  });

  it('selects all TypeScript graph-risk detectors or an explicit repeatable subset', () => {
    const all = parseGraphRiskCalibrationOptions([], ['/repos/a', '/repos/b']);
    expect(all).toMatchObject({
      language: 'typescript',
      seed: 'typescript-graph-risk-v1',
      roots: ['/repos/a', '/repos/b'],
    });
    expect(all.detectors).toEqual([
      'extract-candidates',
      'locality-candidates',
      'coupling',
      'bottlenecks',
      'deep-chains',
      'complexity-hotspots',
      'hotspots',
      'fan-in',
      'fan-out',
    ]);
    expect(
      parseGraphRiskCalibrationOptions(
        ['--detector', 'fan-in', '--detector', 'fan-in', '--sample-size', '8', '/repos/custom'],
        ['/repos/default'],
      ),
    ).toMatchObject({ detectors: ['fan-in'], sampleSize: 8, roots: ['/repos/custom'] });
    expect(() => parseGraphRiskCalibrationOptions(['--detector', 'drift'], ['/repos/default'])).toThrow(
      '--detector must be one of',
    );
  });

  it('retains implicit Rust usage evidence in normalized dead-code rows', () => {
    const normalized = normalizeDeadCandidate(
      {
        relativePath: 'src/lib.rs',
        startLine: 4,
        endLine: 7,
        loc: 4,
        symbol: 'rust-analyzer cargo fixture 0.1.0 src/lib.rs/command().',
        shortName: 'src:command()',
        kind: 'dead-code',
        sameFileRefs: 0,
        implicitUsageReason: 'Rust attribute macro #[tauri::command]',
      },
      {
        language: 'rust',
        repository: 'fixture',
        commit: 'abc123',
        evidence: 'graph-fact',
        capabilityStatus: null,
        sourceExcerpt: () => 'fn command() {}',
      },
    );
    expect(normalized).toMatchObject({
      language: 'rust',
      implicitUsageReason: 'Rust attribute macro #[tauri::command]',
    });
  });

  it('normalizes factual rows without erasing detector-specific evidence', () => {
    const normalized = normalizeFactualCandidate(
      {
        relativePath: 'src/a.ts',
        startLine: 3,
        endLine: 5,
        symbol: 'a',
        findingKind: 'cycle',
        details: { path: ['src/a.ts', 'src/b.ts', 'src/a.ts'] },
        sourceExcerpt: 'import "./b";',
      },
      {
        detector: 'cycles',
        repository: 'fixture',
        commit: 'abc123',
        evidence: 'graph-fact',
        capabilityStatus: null,
      },
    );
    expect(normalized).toMatchObject({
      detector: 'cycles',
      findingKind: 'cycle',
      details: { path: ['src/a.ts', 'src/b.ts', 'src/a.ts'] },
    });
    expect(normalized.calibrationId).toHaveLength(20);
  });

  it('normalizes both endpoints and review dimensions for similarity rows', () => {
    const normalized = normalizeSimilarityCandidate(
      {
        relativePath: 'src/a.ts',
        startLine: 2,
        symbol: 'a = b',
        endpoints: [
          { file: 'src/a.ts', symbol: 'a' },
          { file: 'src/b.ts', symbol: 'b' },
        ],
        details: { similarity: 0.8 },
      },
      {
        detector: 'similar',
        repository: 'fixture',
        commit: 'abc123',
        evidence: 'heuristic',
        capabilityStatus: null,
      },
    );
    expect(normalized).toMatchObject({
      endpoints: [
        { file: 'src/a.ts', symbol: 'a' },
        { file: 'src/b.ts', symbol: 'b' },
      ],
      verdict: null,
      utilityVerdict: null,
    });
  });

  it('assigns stable identities and deterministic seeded samples', () => {
    const rows = Array.from({ length: 20 }, (_, index) => row(index));
    expect(calibrationRowIdentity(rows[0])).toBe(calibrationRowIdentity({ ...rows[0] }));
    expect(deterministicSample(rows, 5, 'seed-a')).toEqual(deterministicSample([...rows].reverse(), 5, 'seed-a'));
    expect(deterministicSample(rows, 5, 'seed-a')).not.toEqual(deterministicSample(rows, 5, 'seed-b'));
  });

  it('keeps a fixed deterministic sample representative across unequal strata', () => {
    const rows = [
      ...Array.from({ length: 20 }, (_, index) => row(index, { detector: 'dominant' })),
      row(20, { detector: 'small-a' }),
      row(21, { detector: 'small-b' }),
    ];
    const selected = deterministicStratifiedSample(rows, 6, 'strata', (entry: CalibrationTestRow) => entry.detector);
    expect(selected).toHaveLength(6);
    expect(new Set(selected.map((entry: CalibrationTestRow) => entry.detector))).toEqual(
      new Set(['dominant', 'small-a', 'small-b']),
    );
    expect(selected).toEqual(
      deterministicStratifiedSample([...rows].reverse(), 6, 'strata', (entry: CalibrationTestRow) => entry.detector),
    );
    expect(
      deterministicStratifiedSample(rows, 50, 'strata', (entry: CalibrationTestRow) => entry.detector),
    ).toHaveLength(rows.length);
    expect(() => deterministicStratifiedSample(rows, -1, 'strata', () => 'all')).toThrow(
      'sample count must be a non-negative integer',
    );
  });

  it('computes the conservative 95% Wilson interval', () => {
    expect(wilsonInterval(95, 100).lower).toBeCloseTo(0.888, 3);
    expect(wilsonInterval(97, 100).lower).toBeGreaterThan(0.9);
    expect(wilsonInterval(0, 0)).toEqual({ lower: null, upper: null });
  });

  it('requires repository breadth, confidence, and recall evidence for certification', () => {
    const certifiedRows = Array.from({ length: 100 }, (_, index) =>
      row(index, { verdict: index < 97 ? 'valid' : 'invalid' }),
    );
    expect(summarizeCalibration(certifiedRows, { knownPositiveRecallCases: 1 }).certification).toBe('certified');
    expect(summarizeCalibration(certifiedRows).certification).toBe('qualified');
    expect(summarizeCalibration(certifiedRows.slice(0, 20), { knownPositiveRecallCases: 1 }).certification).toBe(
      'insufficient-evidence',
    );
  });

  it('keeps uncertain and pending rows out of observed precision', () => {
    const summary = summarizeCalibration([
      row(0, { verdict: 'valid' }),
      row(1, { verdict: 'invalid' }),
      row(2, { verdict: 'uncertain' }),
      row(3, { verdict: null }),
    ]);
    expect(summary).toMatchObject({ reviewed: 2, valid: 1, invalid: 1, uncertain: 1, pending: 1 });
    expect(summary.observedPrecision).toBe(0.5);
  });

  it('reports unsupported capability separately from a clean result', () => {
    expect(summarizeCalibration([], { unsupported: true }).certification).toBe('unsupported');
  });

  it('summarizes mixed factual packets independently by detector', () => {
    const rows = [
      row(0, { detector: 'cycles', verdict: 'valid' }),
      row(1, { detector: 'cycles', verdict: 'invalid' }),
      row(2, { detector: 'unused-imports', verdict: 'valid' }),
    ];
    expect(summarizeCalibrationByDetector(rows)).toMatchObject({
      cycles: { reviewed: 2, valid: 1, invalid: 1 },
      'unused-imports': { reviewed: 1, valid: 1 },
    });
  });

  it('retains declared detectors with no holdout findings as insufficient evidence', () => {
    expect(summarizeCalibrationByDetector([], { detectors: ['decorative-checkers'] })).toMatchObject({
      'decorative-checkers': { reviewed: 0, pending: 0, certification: 'insufficient-evidence' },
    });
  });

  it('applies grouped verdict evidence exactly once per known row', () => {
    const rows = deterministicSample([row(0), row(1)], 2, 'verdicts');
    const classified = applyVerdictGroups(rows, [
      {
        verdict: 'invalid',
        archetype: 'framework-entrypoint',
        evidenceNote: 'Loaded by file convention.',
        ids: [rows[0].calibrationId],
      },
      { verdict: 'valid', evidenceNote: 'No consumers found.', ids: [rows[1].calibrationId] },
    ]);
    expect(classified.map((entry: CalibrationTestRow & { noiseArchetype?: string | null }) => entry.verdict)).toEqual([
      'invalid',
      'valid',
    ]);
    expect(classified[0].noiseArchetype).toBe('framework-entrypoint');
    expect(() =>
      applyVerdictGroups(rows, [
        { verdict: 'valid', evidenceNote: 'first', ids: [rows[0].calibrationId] },
        { verdict: 'valid', evidenceNote: 'duplicate', ids: [rows[0].calibrationId] },
      ]),
    ).toThrow('more than one verdict');
  });

  it('records recommendation utility separately from relationship truth', () => {
    const rows = deterministicSample(
      [row(0, { detector: 'similar', verdict: 'valid' }), row(1, { detector: 'similar', verdict: 'valid' })],
      2,
      'utility',
    );
    const classified = applyUtilityGroups(rows, [
      { verdict: 'actionable', evidenceNote: 'Same behavior.', ids: [rows[0].calibrationId] },
      {
        verdict: 'non-actionable',
        archetype: 'boundary-duplication',
        evidenceNote: 'Intentional boundary.',
        ids: [rows[1].calibrationId],
      },
    ]);
    expect(summarizeUtilityByDetector(classified, { detectors: ['similar'] })).toMatchObject({
      similar: { reviewed: 2, actionable: 1, nonActionable: 1, observedUtilityRate: 0.5 },
    });
    expect(classified[1]).toHaveProperty('utilityArchetype', 'boundary-duplication');
  });

  it('supports packet-scoped detector selectors without weakening exact id overlays', () => {
    const rows = deterministicSample(
      [row(0, { detector: 'similar', verdict: null }), row(1, { detector: 'similar-files', verdict: null })],
      2,
      'selectors',
    );
    const classified = applyVerdictGroups(rows, [
      { verdict: 'valid', evidenceNote: 'Reviewed full detector sample.', detectors: ['similar'] },
    ]);
    expect(classified.find((entry) => entry.detector === 'similar')).toMatchObject({ verdict: 'valid' });
    expect(classified.find((entry) => entry.detector === 'similar-files')).toMatchObject({ verdict: null });
    expect(() =>
      applyVerdictGroups(rows, [
        {
          verdict: 'valid',
          evidenceNote: 'ambiguous selector',
          ids: [rows[0].calibrationId],
          detectors: ['similar'],
        },
      ]),
    ).toThrow('exactly one of ids or detectors');
  });
});
