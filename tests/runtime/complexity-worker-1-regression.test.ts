import { describe, expect, it } from 'vitest';
import { createCliJsonEnvelope, decodeCliJsonEnvelope } from '../../src/runtime/cli-json-envelope.js';

const current = createCliJsonEnvelope({
  producerVersion: '1.0.0',
  command: 'stats',
  args: [],
  options: {},
  result: { documents: 2 },
});

describe('envelope validation precedence after responsibility extraction', () => {
  it.each([
    [{ kind: undefined, schemaVersion: 0 }, 'Unsupported CLI JSON envelope kind: undefined.'],
    [{ schemaVersion: 0, command: '' }, 'CLI JSON envelope schemaVersion must be a positive safe integer.'],
    [{ command: '', producer: null }, 'CLI JSON envelope v1: command must be a non-empty string.'],
    [
      { producer: null, resultSchemaVersion: 0 },
      'CLI JSON envelope v1: producer must identify scip-query and its non-empty version.',
    ],
    [
      { resultSchemaVersion: 0, resultProjection: 'full' },
      'CLI JSON envelope v1: resultSchemaVersion must be a positive safe integer.',
    ],
    [
      { resultSchemaVersion: 2, resultProjection: 'full' },
      'CLI JSON envelope v1: resultProjection must be "agent" when present.',
    ],
    [
      { evidenceContext: {}, operationRole: 'unknown' },
      'CLI JSON envelope v1: evidenceContext must contain a supported receipt and analysis manifest.',
    ],
  ])('reports the earliest invalid contract for %j', (fields, reason) => {
    expect(decodeCliJsonEnvelope({ ...current, ...fields })).toEqual({ kind: 'malformed', reason });
  });

  it('rejects an unsupported envelope version before examining current-version fields', () => {
    expect(decodeCliJsonEnvelope({ ...current, schemaVersion: 2, command: '', evidenceContext: {} })).toEqual({
      kind: 'unsupported',
      schemaVersion: 2,
      direction: 'future',
      producer: current.producer,
    });
  });

  it('rejects an unsupported result version before examining evidence metadata', () => {
    expect(
      decodeCliJsonEnvelope({ ...current, resultSchemaVersion: 2, evidenceContext: {}, operationRole: 'unknown' }),
    ).toEqual({
      kind: 'unsupported-result',
      schemaVersion: 1,
      command: 'stats',
      resultSchemaVersion: 2,
      supportedResultSchemaVersions: [1],
    });
  });

  it('preserves the original accepted envelope and its additive fields', () => {
    const input = { ...current, extra: { future: true } };
    const decoded = decodeCliJsonEnvelope(input);
    expect(decoded.kind).toBe('supported');
    if (decoded.kind !== 'supported') throw new Error('expected a supported envelope');
    expect(decoded.envelope).toBe(input);
  });
});
