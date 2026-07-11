import { describe, expect, it } from 'vitest';
// The calibration core is an executable-script module and intentionally stays
// as native ESM outside the shipped TypeScript source tree.
// @ts-expect-error native script modules do not ship TypeScript declarations
import {
  applyVerdictGroups,
  calibrationRowIdentity,
  deterministicSample,
  normalizeDeadCandidate,
  parseDeadCalibrationOptions,
  summarizeCalibration,
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

  it('assigns stable identities and deterministic seeded samples', () => {
    const rows = Array.from({ length: 20 }, (_, index) => row(index));
    expect(calibrationRowIdentity(rows[0])).toBe(calibrationRowIdentity({ ...rows[0] }));
    expect(deterministicSample(rows, 5, 'seed-a')).toEqual(deterministicSample([...rows].reverse(), 5, 'seed-a'));
    expect(deterministicSample(rows, 5, 'seed-a')).not.toEqual(deterministicSample(rows, 5, 'seed-b'));
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
});
