import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
// @ts-expect-error native script module has no shipped declarations
import { deterministicSample, deterministicStratifiedSample } from '../../scripts/accuracy-calibration-core.mjs';

function calibrationFunctions(names: string[], globals: Record<string, unknown> = {}) {
  const path = 'scripts/accuracy-calibration.mjs';
  const source = ts.createSourceFile(
    path,
    readFileSync(resolve(path), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const selected = source.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ''),
  );
  expect(selected).toHaveLength(names.length);
  const context = createContext({ Error, resolve, join, ...globals });
  // Only the named function declarations execute: no script startup or external trials.
  runInContext(selected.map((node) => node.getText(source)).join('\n'), context);
  return context;
}

const summaryFunctions = ['resampledPacketSummary', 'reviewedPacketSummary', 'isRelationshipPacket'];

describe('wave5 calibration script contracts', () => {
  it('samples deterministically in repository and detector order and keeps repository counts distinct', () => {
    const context = calibrationFunctions(
      ['resamplePacketRows', 'resampledRepository', 'usesStratifiedRelationshipSample'],
      { deterministicSample, deterministicStratifiedSample },
    );
    const rows = [
      { repository: 'b', detector: 'two', findingKind: 'x', calibrationId: 'b2' },
      { repository: 'a', detector: 'one', findingKind: 'x', calibrationId: 'a1' },
      { repository: 'a', detector: 'one', findingKind: 'y', calibrationId: 'a2' },
      { repository: 'a', detector: 'two', findingKind: 'x', calibrationId: 'a3' },
    ];
    const packet = {
      detector: 'typescript-architecture',
      detectors: ['two', 'one'],
      seed: 'fixed',
      repositories: [{ repository: 'b' }, { repository: 'a' }],
      rows,
    };
    const sampled = context.resamplePacketRows(packet, 1);
    expect(sampled.map((row: { repository: string; detector: string }) => [row.repository, row.detector])).toEqual([
      ['b', 'two'],
      ['a', 'two'],
      ['a', 'one'],
    ]);
    expect(context.resamplePacketRows(packet, 1)).toEqual(sampled);
    expect(context.resampledRepository(packet, packet.repositories[1], 1)).toEqual({
      repository: 'a',
      sampledCounts: { two: 1, one: 1 },
    });
    expect(context.resampledRepository({ rows }, { repository: 'a' }, 2)).toEqual({ repository: 'a', sampled: 2 });
  });

  it('preserves separate summary options for resampled and reviewed packet families', () => {
    const context = calibrationFunctions(summaryFunctions, {
      similarityPacketSummary: (...args: unknown[]) => ['relationship', ...args],
      summarizeCalibrationByDetector: (...args: unknown[]) => ['factual', ...args],
      summarizeCalibration: (...args: unknown[]) => ['dead', ...args],
    });
    const rows: unknown[] = [];
    expect(context.resampledPacketSummary({ detector: 'typescript-factual' }, rows)).toEqual([
      'factual',
      rows,
      { detectors: [] },
    ]);
    expect(context.reviewedPacketSummary({ detector: 'typescript-factual' }, rows, {}, 4)).toEqual([
      'factual',
      rows,
      { detectors: [], knownPositiveRecallCases: {} },
    ]);
    expect(context.reviewedPacketSummary({ detector: 'dead' }, rows, {}, {})).toEqual([
      'dead',
      rows,
      { knownPositiveRecallCases: 0 },
    ]);
    const verdicts = { utilityGroups: ['retain'] };
    expect(
      context.reviewedPacketSummary({ detector: 'typescript-framework', detectors: ['a'] }, rows, verdicts, 0),
    ).toEqual(['relationship', rows, ['a'], verdicts]);
  });

  it('keeps read/error precedence and JSON-before-Markdown write ordering in summarize mode', () => {
    const events: string[] = [];
    const writes: string[] = [];
    const packet = { schemaVersion: 1, language: 'typescript', detector: 'dead', rows: [] };
    const context = calibrationFunctions(
      ['runSummarizeMode', 'reviewedPacketSummary', 'renderCalibrationPacket', 'isRelationshipPacket'],
      {
        CALIBRATION_SCHEMA_VERSION: 1,
        runId: 'fixed',
        outDir: '/out',
        readFileSync: (path: string) => {
          events.push(path);
          return JSON.stringify(path.endsWith('packet.json') ? packet : {});
        },
        applyVerdictGroups: (rows: unknown[]) => rows,
        summarizeCalibration: () => ({ count: 0 }),
        renderDeadPacket: () => {
          events.push('render');
          return 'markdown';
        },
        writeFileSync: (path: string) => {
          events.push('write');
          writes.push(path);
        },
        console: { log: () => events.push('log') },
      },
    );
    expect(() => context.runSummarizeMode(['packet.json'])).toThrow('summarize requires');
    expect(events).toEqual([]);
    context.runSummarizeMode(['packet.json', 'verdicts.json']);
    expect(events.slice(2)).toEqual(['write', 'render', 'write', 'log', 'log']);
    expect(writes).toEqual(['/out/fixed-typescript-dead-reviewed.json', '/out/fixed-typescript-dead-reviewed.md']);
    packet.schemaVersion = 2;
    events.length = 0;
    expect(() => context.runSummarizeMode(['packet.json', 'verdicts.json'])).toThrow(
      'unsupported calibration packet schema: 2',
    );
    expect(events).toHaveLength(2);
  });

  it('retains relationship Markdown defaults, zero-based-to-display lines, and final newline', () => {
    const context = calibrationFunctions([
      'renderRelationshipPacket',
      'appendRelationshipRepository',
      'appendRelationshipRow',
    ]);
    const text = context.renderRelationshipPacket(
      {
        generatedAt: 'now',
        schemaVersion: 1,
        seed: 'fixed',
        detectors: [],
        truthRules: {},
        repositories: [{ repository: 'repo' }],
        summary: {},
        rows: [
          {
            detector: 'd',
            repository: 'repo',
            shortName: 'f',
            calibrationId: 'id',
            commit: 'abc',
            relativePath: 'f.ts',
            startLine: 0,
            endLine: 2,
            endpoints: [],
            evidence: 'exact',
            findingKind: 'kind',
            details: [],
          },
        ],
      },
      'Title',
    );
    expect(text).toContain('- Commit: `-`');
    expect(text).toContain('- Primary location: `f.ts:1-3`');
    expect(text).toContain('- Relationship verdict: **PENDING**');
    expect(text).toContain('- Recommendation utility: **PENDING**');
    expect(text).toContain('````text\n(source unavailable)\n````');
    expect(text.endsWith('\n\n')).toBe(true);
  });
});
