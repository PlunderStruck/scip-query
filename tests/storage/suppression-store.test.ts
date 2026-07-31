import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileRevisionConflictError } from '../../src/runtime/revisioned-file.js';
import {
  buildAutomatedSuppressionDecision,
  formatSuppressionWriteReceipt,
  SuppressionWriteConflictError,
  writeSuppressionFile,
} from '../../src/runtime/suppression-writer.js';
import {
  decodeSuppressionFile,
  LEGACY_SUPPRESSION_FILE_SCHEMA_VERSION,
  readSuppressionDir,
  SUPPRESSION_FILE_KIND,
  SUPPRESSION_FILE_SCHEMA_VERSION,
  suppressionDirPath,
  suppressionFileName,
  suppressionIdentity,
  type SuppressionFileRecord,
  type SuppressionFileRecordV1,
} from '../../src/storage/suppression-store.js';

const roots: string[] = [];
const FIRST_TIME = new Date('2026-07-07T12:00:00.000Z');
const SECOND_TIME = new Date('2026-07-08T12:00:00.000Z');
const TEST_VERSION = 'test-version';

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'scipq-suppression-'));
  roots.push(root);
  return root;
}

function suppressionPath(root: string, id: string): string {
  return join(suppressionDirPath(root), `${id}.json`);
}

function readRaw(path: string): SuppressionFileRecord {
  return JSON.parse(readFileSync(path, 'utf8')) as SuppressionFileRecord;
}

function record(id: string, reason: string): SuppressionFileRecordV1 {
  return {
    kind: SUPPRESSION_FILE_KIND,
    schemaVersion: LEGACY_SUPPRESSION_FILE_SCHEMA_VERSION,
    suppressionIdentity: id,
    writer: { tool: 'scip-query', version: TEST_VERSION },
    id,
    reason,
    createdAt: FIRST_TIME.toISOString(),
  };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('suppression identity', () => {
  it('uses the finding id when present', () => {
    const suppression = { id: 'SQABC123DEF456', reason: 'x' };
    expect(suppressionFileName(suppression)).toBe('SQABC123DEF456.json');
    expect(suppressionIdentity(suppression)).toBe('SQABC123DEF456');
  });

  it('derives a stable hash name for check-level suppressions', () => {
    const first = suppressionFileName({ check: 'echo', file: 'src/a.ts', reason: 'x' });
    const second = suppressionFileName({ check: 'echo', file: 'src/a.ts', reason: 'different reason' });
    expect(first).toBe(second);
    expect(first).toMatch(/^CHECK-[0-9A-F]{12}\.json$/);
    expect(suppressionFileName({ check: 'echo', file: 'src/b.ts', reason: 'x' })).not.toBe(first);
  });
});

describe('writeSuppressionFile', () => {
  it('renders suppression scope, adjudication evidence, and lifetime explicitly', () => {
    const suppression = {
      id: 'SQABC123DEF456',
      check: 'echo',
      file: 'src/compat.ts',
      reason: 'fixture overlap',
      decision: {
        kind: 'automated-adjudication' as const,
        reasonCode: 'compatibility-shim' as const,
        decidedBy: 'agent' as const,
        policyVersion: 1 as const,
        evidence: [
          {
            kind: 'graph' as const,
            referent: 'scip-query refs compat --full',
            claim: 'the public shim remains reachable',
          },
        ],
        invalidateOn: { targetContentChange: false, detectorMajorChange: true },
      },
    };
    const result = {
      path: '/repo/.scipquery/suppressions/SQABC123DEF456.json',
      disposition: 'created' as const,
      revision: 'a'.repeat(64),
    };

    expect(formatSuppressionWriteReceipt(result, suppression)).toEqual([
      'Suppression created at /repo/.scipquery/suppressions/SQABC123DEF456.json.',
      '  scope: finding SQABC123DEF456; check echo; file src/compat.ts',
      '  reason code: compatibility-shim',
      '  counterevidence: 1 item(s)',
      '  expires: none — no time limit; evidence invalidation still applies',
      `  revision: ${'a'.repeat(64)}`,
    ]);
    expect(formatSuppressionWriteReceipt(result, { ...suppression, expiresAt: SECOND_TIME.toISOString() })[4]).toBe(
      `  expires: ${SECOND_TIME.toISOString()}`,
    );
  });

  it('exclusively creates a versioned record and returns its revision', () => {
    const root = createRoot();
    const result = writeSuppressionFile(
      root,
      { id: 'SQABC123DEF456', check: 'echo', reason: 'fixture overlap' },
      { now: FIRST_TIME, toolVersion: TEST_VERSION },
    );

    expect(result).toMatchObject({
      path: suppressionPath(root, 'SQABC123DEF456'),
      disposition: 'created',
    });
    expect(result.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(readRaw(result.path)).toEqual({
      kind: SUPPRESSION_FILE_KIND,
      schemaVersion: 1,
      suppressionIdentity: 'SQABC123DEF456',
      writer: { tool: 'scip-query', version: TEST_VERSION },
      id: 'SQABC123DEF456',
      check: 'echo',
      reason: 'fixture overlap',
      createdAt: FIRST_TIME.toISOString(),
    });

    expect(readSuppressionDir(root)).toEqual({
      warnings: [],
      compatibility: {
        complete: true,
        total: 1,
        accepted: 1,
        legacy: 1,
        current: 0,
        unsupportedOlder: 0,
        unsupportedFuture: 0,
        malformed: 0,
        omitted: 0,
        issues: [],
      },
      suppressions: [
        {
          id: 'SQABC123DEF456',
          check: 'echo',
          reason: 'fixture overlap',
          createdAt: FIRST_TIME.toISOString(),
        },
      ],
    });
  });

  it('writes current adjudicated records with content-bound evidence', () => {
    const root = createRoot();
    writeFileSync(join(root, 'source.ts'), 'export const value = 1;\n');
    const decision = buildAutomatedSuppressionDecision(
      root,
      'compatibility-shim',
      ['source:source.ts'],
      'The v1 export remains public.',
    );

    const result = writeSuppressionFile(
      root,
      { id: 'SQCURRENT', reason: 'The v1 export remains public.', decision },
      { now: FIRST_TIME, toolVersion: TEST_VERSION },
    );

    expect(readRaw(result.path)).toMatchObject({
      schemaVersion: SUPPRESSION_FILE_SCHEMA_VERSION,
      decision: {
        reasonCode: 'compatibility-shim',
        evidence: [
          {
            kind: 'source',
            referent: 'source.ts',
            contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        ],
      },
    });
    expect(readSuppressionDir(root).compatibility).toMatchObject({ legacy: 0, current: 1 });
  });

  it('treats an identical replay as idempotent without changing bytes or metadata', () => {
    const root = createRoot();
    const suppression = { id: 'SQAAA', reason: 'same decision' };
    const first = writeSuppressionFile(root, suppression, {
      now: FIRST_TIME,
      toolVersion: TEST_VERSION,
    });
    const before = readFileSync(first.path, 'utf8');

    const replay = writeSuppressionFile(root, suppression, {
      now: SECOND_TIME,
      toolVersion: 'different-client-version',
    });

    expect(replay).toEqual({ path: first.path, revision: first.revision, disposition: 'unchanged' });
    expect(readFileSync(first.path, 'utf8')).toBe(before);
  });

  it('rejects a different decision until the caller supplies the observed revision', () => {
    const root = createRoot();
    const first = writeSuppressionFile(
      root,
      { id: 'SQAAA', reason: 'first' },
      { now: FIRST_TIME, toolVersion: TEST_VERSION },
    );

    let conflict: unknown;
    try {
      writeSuppressionFile(root, { id: 'SQAAA', reason: 'second' });
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(SuppressionWriteConflictError);
    expect(conflict).toMatchObject({ path: first.path, currentRevision: first.revision });
    expect((conflict as Error).message).toContain(`--replace ${first.revision}`);
    expect(readRaw(first.path).reason).toBe('first');

    const replacement = writeSuppressionFile(
      root,
      { id: 'SQAAA', reason: 'second' },
      {
        expectedRevision: first.revision,
        now: SECOND_TIME,
        toolVersion: TEST_VERSION,
      },
    );
    expect(replacement.disposition).toBe('replaced');
    expect(replacement.revision).not.toBe(first.revision);
    expect(readRaw(first.path)).toMatchObject({
      reason: 'second',
      createdAt: FIRST_TIME.toISOString(),
      updatedAt: SECOND_TIME.toISOString(),
    });
  });

  it('rejects a stale replacement revision and preserves the winning decision', () => {
    const root = createRoot();
    const first = writeSuppressionFile(root, { id: 'SQAAA', reason: 'first' }, { now: FIRST_TIME });
    const second = writeSuppressionFile(
      root,
      { id: 'SQAAA', reason: 'second' },
      { expectedRevision: first.revision, now: SECOND_TIME },
    );

    expect(() =>
      writeSuppressionFile(root, { id: 'SQAAA', reason: 'stale third decision' }, { expectedRevision: first.revision }),
    ).toThrow(/changed after the revision you reviewed/);
    expect(readRaw(first.path).reason).toBe('second');
    expect(second.revision).toMatch(/^[0-9a-f]{64}$/);
  });

  it('preserves a competing first decision published at the commit boundary', () => {
    const root = createRoot();
    const path = suppressionPath(root, 'SQAAA');
    let competingBytes = '';

    expect(() =>
      writeSuppressionFile(
        root,
        { id: 'SQAAA', reason: 'our decision' },
        {
          onBeforeCommit: () => {
            competingBytes = `${JSON.stringify(record('SQAAA', 'competing decision'), null, 2)}\n`;
            writeFileSync(path, competingBytes);
          },
        },
      ),
    ).toThrow(FileRevisionConflictError);
    expect(readFileSync(path, 'utf8')).toBe(competingBytes);
    expect(readSuppressionDir(root).suppressions[0]?.reason).toBe('competing decision');
  });

  it('keeps decisions for different identities in independent files', () => {
    const root = createRoot();
    writeSuppressionFile(root, { id: 'SQAAA', reason: 'first identity' });
    writeSuppressionFile(root, { id: 'SQBBB', reason: 'second identity' });

    expect(readSuppressionDir(root).suppressions.map(({ id }) => id)).toEqual(['SQAAA', 'SQBBB']);
  });

  it('rejects invalid inputs and replacement revisions before writing', () => {
    const root = createRoot();
    expect(() => writeSuppressionFile(root, { id: 'SQAAA', reason: '  ' })).toThrow(/reason/);
    expect(() => writeSuppressionFile(root, { reason: 'valid' })).toThrow(/id or a check/);
    expect(() => writeSuppressionFile(root, { id: 'SQAAA', reason: 'valid' }, { expectedRevision: 'short' })).toThrow(
      /64-character SHA-256/,
    );
    expect(readSuppressionDir(root)).toMatchObject({
      suppressions: [],
      compatibility: { complete: true, total: 0, accepted: 0, omitted: 0 },
      warnings: [],
    });
  });

  it('refuses malformed or future-schema records without changing their bytes', () => {
    const root = createRoot();
    const dir = suppressionDirPath(root);
    mkdirSync(dir, { recursive: true });
    const path = suppressionPath(root, 'SQAAA');

    for (const bytes of ['{ malformed', `${JSON.stringify({ ...record('SQAAA', 'future'), schemaVersion: 3 })}\n`]) {
      writeFileSync(path, bytes);
      expect(() => writeSuppressionFile(root, { id: 'SQAAA', reason: 'replacement' })).toThrow(
        /malformed JSON|unsupported schemaVersion 3/,
      );
      expect(readFileSync(path, 'utf8')).toBe(bytes);
    }
  });

  it('preserves existing bytes and releases its lock when work fails before commit', () => {
    const root = createRoot();
    const first = writeSuppressionFile(root, { id: 'SQAAA', reason: 'first' }, { now: FIRST_TIME });
    const before = readFileSync(first.path, 'utf8');

    expect(() =>
      writeSuppressionFile(
        root,
        { id: 'SQAAA', reason: 'second' },
        {
          expectedRevision: first.revision,
          onBeforeCommit: () => {
            throw new Error('injected crash');
          },
        },
      ),
    ).toThrow('injected crash');
    expect(readFileSync(first.path, 'utf8')).toBe(before);

    const replacement = writeSuppressionFile(
      root,
      { id: 'SQAAA', reason: 'second' },
      { expectedRevision: first.revision, now: SECOND_TIME },
    );
    expect(replacement.disposition).toBe('replaced');
  });

  it('does not overwrite an uncooperative edit that lands during replacement', () => {
    const root = createRoot();
    const first = writeSuppressionFile(root, { id: 'SQAAA', reason: 'first' }, { now: FIRST_TIME });
    const externalBytes = `${JSON.stringify(record('SQAAA', 'external winner'), null, 2)}\n`;

    expect(() =>
      writeSuppressionFile(
        root,
        { id: 'SQAAA', reason: 'our replacement' },
        {
          expectedRevision: first.revision,
          onBeforeCommit: () => writeFileSync(first.path, externalBytes),
        },
      ),
    ).toThrow(FileRevisionConflictError);
    expect(readFileSync(first.path, 'utf8')).toBe(externalBytes);
  });

  it('reads legacy records and upgrades them only through explicit replacement', () => {
    const root = createRoot();
    const path = suppressionPath(root, 'SQAAA');
    mkdirSync(suppressionDirPath(root), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ id: 'SQAAA', reason: 'legacy', createdAt: FIRST_TIME.toISOString() }, null, 2)}\n`,
    );

    const replay = writeSuppressionFile(root, { id: 'SQAAA', reason: 'legacy' });
    expect(replay.disposition).toBe('unchanged');
    expect(readRaw(path).schemaVersion).toBeUndefined();

    writeSuppressionFile(
      root,
      { id: 'SQAAA', reason: 'upgraded' },
      { expectedRevision: replay.revision, now: SECOND_TIME, toolVersion: TEST_VERSION },
    );
    expect(readRaw(path)).toMatchObject({
      schemaVersion: 1,
      suppressionIdentity: 'SQAAA',
      reason: 'upgraded',
      createdAt: FIRST_TIME.toISOString(),
      updatedAt: SECOND_TIME.toISOString(),
    });
  });
});

describe('decodeSuppressionFile / readSuppressionDir', () => {
  it('returns empty for a missing directory', () => {
    expect(readSuppressionDir(createRoot())).toMatchObject({
      suppressions: [],
      compatibility: { complete: true, total: 0, accepted: 0, omitted: 0 },
      warnings: [],
    });
  });

  it('accepts pre-discriminator v1 and distinguishes malformed, older, and future records', () => {
    const { kind: _kind, ...preDiscriminatorV1 } = record('SQAAA', 'valid');
    expect(decodeSuppressionFile(preDiscriminatorV1, 'SQAAA')).toMatchObject({
      state: 'legacy',
      schemaVersion: 1,
      suppression: { id: 'SQAAA', reason: 'valid' },
    });
    expect(decodeSuppressionFile(record('SQAAA', 'valid'), 'SQBBB')).toEqual({
      state: 'malformed',
      error: 'suppressionIdentity does not match the suppression target or filename',
    });
    expect(decodeSuppressionFile({ ...record('SQAAA', 'older'), schemaVersion: 0 })).toEqual({
      state: 'unsupported-older',
      error: 'unsupported schemaVersion 0',
    });
    expect(decodeSuppressionFile({ ...record('SQAAA', 'future'), schemaVersion: 3 })).toEqual({
      state: 'unsupported-future',
      error: 'unsupported schemaVersion 3',
    });
    expect(decodeSuppressionFile({ ...record('SQAAA', 'wrong kind'), kind: 'other' })).toEqual({
      state: 'malformed',
      error: `kind must be ${SUPPRESSION_FILE_KIND}`,
    });
    expect(decodeSuppressionFile({ id: 'SQAAA', reason: 'partial envelope', kind: SUPPRESSION_FILE_KIND })).toEqual({
      state: 'malformed',
      error: 'suppression envelope metadata requires schemaVersion',
    });
  });

  it('skips malformed, invalid, mismatched, and future files while keeping valid ones', () => {
    const root = createRoot();
    const dir = suppressionDirPath(root);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'broken.json'), '{ not json');
    writeFileSync(join(dir, 'no-reason.json'), JSON.stringify({ id: 'SQBBB' }));
    writeFileSync(join(dir, 'no-target.json'), JSON.stringify({ reason: 'reason without target' }));
    writeFileSync(join(dir, 'SQDRIFT.json'), JSON.stringify(record('SQOTHER', 'wrong file')));
    writeFileSync(join(dir, 'SQFUTURE.json'), JSON.stringify({ ...record('SQFUTURE', 'future'), schemaVersion: 9 }));
    writeFileSync(join(dir, 'notes.txt'), 'ignored entirely');
    writeSuppressionFile(root, { id: 'SQCCC', reason: 'valid' });

    const read = readSuppressionDir(root);
    expect(read.suppressions.map((suppression) => suppression.id)).toEqual(['SQCCC']);
    expect(read.warnings).toHaveLength(5);
    expect(read.compatibility).toMatchObject({
      complete: false,
      total: 6,
      accepted: 1,
      legacy: 1,
      current: 0,
      unsupportedFuture: 1,
      malformed: 4,
      omitted: 5,
    });
    expect(read.warnings.join('\n')).toMatch(/malformed JSON/);
    expect(read.warnings.join('\n')).toMatch(/missing reason/);
    expect(read.warnings.join('\n')).toMatch(/id or a check/);
    expect(read.warnings.join('\n')).toMatch(/does not match/);
    expect(read.warnings.join('\n')).toMatch(/unsupported schemaVersion 9/);
  });

  it('keeps the packaged JSON Schema aligned with the runtime envelope', () => {
    const schema = JSON.parse(
      readFileSync(join(process.cwd(), 'docs', 'schemas', 'suppression-record.schema.json'), 'utf-8'),
    ) as {
      required: string[];
      properties: Record<
        string,
        { const?: unknown; properties?: Record<string, { properties?: Record<string, { $ref?: unknown }> }> }
      >;
      additionalProperties: boolean;
    };

    expect(schema.properties['kind']?.const).toBe(SUPPRESSION_FILE_KIND);
    expect(schema.properties['schemaVersion']?.const).toBe(SUPPRESSION_FILE_SCHEMA_VERSION);
    expect(schema.properties['decision']?.properties?.['observation']?.['$ref']).toBe(
      './observation-receipt.schema.json',
    );
    expect(schema.required).toEqual(
      expect.arrayContaining([
        'kind',
        'schemaVersion',
        'suppressionIdentity',
        'writer',
        'reason',
        'createdAt',
        'decision',
      ]),
    );
    expect(schema.additionalProperties).toBe(true);
  });
});
