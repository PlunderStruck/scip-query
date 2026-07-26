import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  deriveOutcomeEvents,
  type FindingOutcomeRecord,
  type OutcomeEvent,
} from '../../src/domain/finding-outcomes.js';
import {
  appendOutcomeEvents,
  dedupeEvents,
  OUTCOME_EVENTS_DIR,
  readOutcomeEvents,
} from '../../src/storage/outcome-events.js';
import {
  createOutcomeEventRecord,
  decodeOutcomeEventRecord,
  OUTCOME_EVENT_RECORD_KIND,
  OUTCOME_EVENT_RECORD_SCHEMA_VERSION,
  outcomeEventIdentity,
} from '../../src/domain/outcome-event-record.js';

const roots: string[] = [];
const TEST_VERSION = '0.19.5-test';

function outcomeEventsDirPath(root: string): string {
  return join(root, OUTCOME_EVENTS_DIR);
}

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'scipq-events-'));
  roots.push(root);
  return root;
}

function append(root: string, events: readonly OutcomeEvent[]) {
  return appendOutcomeEvents(root, events, { toolVersion: TEST_VERSION });
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function record(overrides: Partial<FindingOutcomeRecord>): FindingOutcomeRecord {
  return {
    check: 'echo',
    findingId: 'SQAAA',
    firstSeen: 1_000,
    lastSeen: 1_000,
    timesShown: 1,
    outcome: 'still-open',
    ...overrides,
  };
}

const NO_SYMBOLS = new Map<string, string>();

describe('deriveOutcomeEvents', () => {
  it('emits caught for new findings and suppressed when they arrive suppressed', () => {
    const next = [record({}), record({ findingId: 'SQBBB', outcome: 'suppressed' })];
    const events = deriveOutcomeEvents([], next, new Map([['SQAAA', 'sym#a']]), 'c0ffee', 2_000);

    expect(events).toEqual([
      { ts: 2_000, check: 'echo', findingId: 'SQAAA', event: 'caught', commit: 'c0ffee', symbol: 'sym#a' },
      { ts: 2_000, check: 'echo', findingId: 'SQBBB', event: 'caught', commit: 'c0ffee' },
      { ts: 2_000, check: 'echo', findingId: 'SQBBB', event: 'suppressed', commit: 'c0ffee' },
    ]);
  });

  it('emits one event per outcome transition and nothing for unchanged records', () => {
    const previous = [
      record({}),
      record({ findingId: 'SQBBB' }),
      record({ findingId: 'SQCCC', outcome: 'suppressed' }),
      record({ findingId: 'SQDDD', outcome: 'resolved' }),
    ];
    const next = [
      record({ outcome: 'resolved' }), // still-open -> resolved
      record({ findingId: 'SQBBB', outcome: 'suppressed' }), // still-open -> suppressed
      record({ findingId: 'SQCCC', outcome: 'still-open' }), // suppressed -> still-open (expired suppression)
      record({ findingId: 'SQDDD', outcome: 'resolved' }), // unchanged
    ];
    const events = deriveOutcomeEvents(previous, next, NO_SYMBOLS, null, 3_000);

    expect(events.map((event) => [event.findingId, event.event])).toEqual([
      ['SQAAA', 'resolved'],
      ['SQBBB', 'suppressed'],
      ['SQCCC', 'reopened'],
    ]);
  });

  it('records the resolved comparison base and cross-HEAD verification proof', () => {
    const previous = [record({})];
    const next = [record({ outcome: 'resolved' })];
    const events = deriveOutcomeEvents(previous, next, NO_SYMBOLS, 'head-2', 3_000, {
      comparisonBaseCommit: 'head-2',
      verifiedAgainstByFinding: new Map([['echo\0SQAAA', 'head-1']]),
    });

    expect(events).toEqual([
      {
        ts: 3_000,
        check: 'echo',
        findingId: 'SQAAA',
        event: 'resolved',
        commit: 'head-2',
        comparisonBaseCommit: 'head-2',
        verifiedAgainstCommit: 'head-1',
      },
    ]);
  });
});

describe('append/read round trip', () => {
  it('persists each event in its own JSON file and reads them back', () => {
    const root = createRoot();
    const events: OutcomeEvent[] = [
      { ts: 1, check: 'echo', findingId: 'SQAAA', event: 'caught', commit: 'c1', symbol: 'sym#a' },
      { ts: 2, check: 'echo', findingId: 'SQAAA', event: 'resolved', commit: 'c2' },
    ];
    append(root, events);

    expect(readOutcomeEvents(root).events).toEqual(events);
    const files = readdirSync(outcomeEventsDirPath(root));
    expect(files).toHaveLength(2);
    expect(files.every((file) => /^\d+-[0-9A-F]{16}\.json$/.test(file))).toBe(true);
    expect(JSON.parse(readFileSync(join(outcomeEventsDirPath(root), files[0]), 'utf-8'))).toMatchObject({
      kind: 'scip-query-outcome-event',
      schemaVersion: 1,
      writer: { tool: 'scip-query', version: TEST_VERSION },
    });
  });

  it('appending nothing writes nothing', () => {
    const root = createRoot();
    append(root, []);
    expect(readOutcomeEvents(root)).toMatchObject({
      events: [],
      compatibility: { complete: true, total: 0, omitted: 0 },
      warnings: [],
    });
    expect(existsSync(outcomeEventsDirPath(root))).toBe(false);
  });

  it('treats an exact replay as an idempotent write', () => {
    const root = createRoot();
    const event: OutcomeEvent = { ts: 1, check: 'echo', findingId: 'SQAAA', event: 'caught', commit: null };
    append(root, [event]);
    append(root, [event]);

    expect(readdirSync(outcomeEventsDirPath(root))).toHaveLength(1);
    expect(readOutcomeEvents(root).events).toEqual([event]);
  });

  it('keeps separate files for distinct observations and dedupes the fact to the earliest timestamp', () => {
    const root = createRoot();
    append(root, [
      { ts: 9, check: 'echo', findingId: 'SQAAA', event: 'caught', commit: 'c1' },
      { ts: 3, check: 'echo', findingId: 'SQAAA', event: 'caught', commit: 'c1' },
    ]);

    expect(readdirSync(outcomeEventsDirPath(root))).toHaveLength(2);
    expect(readOutcomeEvents(root).events).toEqual([
      { ts: 3, check: 'echo', findingId: 'SQAAA', event: 'caught', commit: 'c1' },
    ]);
  });

  it('counts malformed JSON files and unknown shapes while keeping compatible records', () => {
    const root = createRoot();
    const dir = outcomeEventsDirPath(root);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'broken.json'), '{"half a file"');
    writeFileSync(join(dir, 'wrong-shape.json'), '{"ts":"wrong types"}');
    writeFileSync(join(dir, 'notes.txt'), 'ignored');
    append(root, [{ ts: 1, check: 'echo', findingId: 'SQAAA', event: 'caught', commit: null }]);

    const read = readOutcomeEvents(root);
    expect(read.events).toHaveLength(1);
    expect(read.events[0].findingId).toBe('SQAAA');
    expect(read.compatibility).toMatchObject({
      complete: false,
      total: 3,
      accepted: 1,
      current: 1,
      malformed: 2,
      omitted: 2,
    });
    expect(read.compatibility.issues.map((issue) => issue.path)).toEqual([
      '.scipquery/events/broken.json',
      '.scipquery/events/wrong-shape.json',
    ]);
  });

  it('reads a mixed legacy/current ledger and migrates legacy records on the next append', () => {
    const root = createRoot();
    append(root, [{ ts: 9, check: 'echo', findingId: 'SQAAA', event: 'caught', commit: 'c1' }]);

    const legacyDir = join(root, '.scipquery', 'ledger');
    const legacyPath = join(legacyDir, 'events.jsonl');
    const attributesPath = join(legacyDir, '.gitattributes');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      legacyPath,
      [
        JSON.stringify({ ts: 3, check: 'echo', findingId: 'SQAAA', event: 'caught', commit: 'c1' }),
        JSON.stringify({ ts: 5, check: 'new-dead', findingId: 'SQBBB', event: 'caught', commit: 'c2' }),
      ].join('\n'),
    );
    writeFileSync(attributesPath, '*.bin binary\nevents.jsonl merge=union\n');

    expect(readOutcomeEvents(root).events.map((event) => event.ts)).toEqual([3, 5]);

    append(root, []);

    expect(existsSync(legacyPath)).toBe(false);
    expect(readFileSync(attributesPath, 'utf-8')).toBe('*.bin binary\n');
    expect(readOutcomeEvents(root).events.map((event) => event.ts)).toEqual([3, 5]);
    expect(readdirSync(outcomeEventsDirPath(root))).toHaveLength(3);
  });

  it('copies compatible legacy rows but preserves the source ledger when any row is incompatible', () => {
    const root = createRoot();
    const legacyDir = join(root, '.scipquery', 'ledger');
    const legacyPath = join(legacyDir, 'events.jsonl');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      legacyPath,
      [
        JSON.stringify({ ts: 3, check: 'echo', findingId: 'SQAAA', event: 'caught', commit: 'c1' }),
        JSON.stringify({ schemaVersion: 2, event: 'future-transition' }),
        'not json',
      ].join('\n'),
    );

    expect(
      append(root, [{ ts: 5, check: 'new-dead', findingId: 'SQBBB', event: 'caught', commit: 'c2' }]),
    ).toMatchObject({ warning: expect.stringMatching(/legacy outcome ledger preserved.*2 of 3/) });
    expect(existsSync(legacyPath)).toBe(true);
    expect(readdirSync(outcomeEventsDirPath(root))).toHaveLength(2);

    const read = readOutcomeEvents(root);
    expect(read.events.map((event) => event.findingId)).toEqual(['SQAAA', 'SQBBB']);
    expect(read.compatibility).toMatchObject({
      complete: false,
      total: 5,
      accepted: 3,
      unsupportedFuture: 1,
      malformed: 1,
      omitted: 2,
    });

    expect(append(root, [])).toMatchObject({ warning: expect.stringContaining('legacy outcome ledger preserved') });
    expect(readdirSync(outcomeEventsDirPath(root))).toHaveLength(2);
  });

  it('dedupes replayed events to the earliest timestamp', () => {
    const duplicated: OutcomeEvent[] = [
      { ts: 9, check: 'echo', findingId: 'SQAAA', event: 'caught', commit: 'c1' },
      { ts: 3, check: 'echo', findingId: 'SQAAA', event: 'caught', commit: 'c1' },
      { ts: 5, check: 'echo', findingId: 'SQAAA', event: 'caught', commit: 'c2' },
    ];
    const deduped = dedupeEvents(duplicated);
    expect(deduped).toHaveLength(2);
    expect(deduped[0]).toMatchObject({ ts: 3, commit: 'c1' });
    expect(deduped[1]).toMatchObject({ ts: 5, commit: 'c2' });
  });

  it('keeps the duplicate observation carrying stronger verification evidence', () => {
    const deduped = dedupeEvents([
      { ts: 1, check: 'echo', findingId: 'SQAAA', event: 'resolved', commit: 'c2' },
      {
        ts: 2,
        check: 'echo',
        findingId: 'SQAAA',
        event: 'resolved',
        commit: 'c2',
        comparisonBaseCommit: 'c2',
        verifiedAgainstCommit: 'c1',
      },
    ]);

    expect(deduped).toEqual([
      expect.objectContaining({ ts: 2, verifiedAgainstCommit: 'c1', comparisonBaseCommit: 'c2' }),
    ]);
  });
});

describe('outcome event record decoder', () => {
  const event: OutcomeEvent = {
    ts: 1,
    check: 'echo',
    findingId: 'SQAAA',
    event: 'caught',
    commit: 'c1',
  };

  it('reads unversioned legacy and round-trips current records without changing semantic identity', () => {
    expect(decodeOutcomeEventRecord(event)).toMatchObject({ state: 'legacy', event, schemaVersion: 0 });
    const current = createOutcomeEventRecord(event, TEST_VERSION);
    expect(current.eventIdentity).toBe(outcomeEventIdentity(event));
    expect(decodeOutcomeEventRecord(current)).toMatchObject({ state: 'current', event, schemaVersion: 1 });
    const {
      kind: _kind,
      schemaVersion: _schemaVersion,
      eventIdentity: _eventIdentity,
      writer: _writer,
      ...fieldsVisibleToPriorReader
    } = current;
    expect(fieldsVisibleToPriorReader).toEqual(event);
  });

  it('distinguishes unsupported versions from malformed current records', () => {
    expect(decodeOutcomeEventRecord({ ...event, schemaVersion: 0 })).toEqual({
      state: 'unsupported-older',
      error: 'unsupported schemaVersion 0',
    });
    expect(decodeOutcomeEventRecord({ ...event, schemaVersion: 2 })).toEqual({
      state: 'unsupported-future',
      error: 'unsupported schemaVersion 2',
    });
    expect(
      decodeOutcomeEventRecord({
        ...createOutcomeEventRecord(event, TEST_VERSION),
        eventIdentity: 'wrong',
      }),
    ).toEqual({
      state: 'malformed',
      error: 'eventIdentity does not match the outcome event',
    });
    expect(decodeOutcomeEventRecord({ ...event, event: 'forgotten' })).toEqual({
      state: 'malformed',
      error: 'invalid legacy outcome event fields',
    });
    expect(decodeOutcomeEventRecord({ ...event, kind: OUTCOME_EVENT_RECORD_KIND })).toEqual({
      state: 'malformed',
      error: 'outcome event envelope metadata requires schemaVersion',
    });
  });

  it('keeps the packaged JSON Schema aligned with the runtime envelope', () => {
    const schema = JSON.parse(
      readFileSync(join(process.cwd(), 'docs', 'schemas', 'outcome-event-record.schema.json'), 'utf-8'),
    ) as {
      required: string[];
      properties: Record<string, { const?: unknown }>;
      additionalProperties: boolean;
    };

    expect(schema.properties['kind']?.const).toBe(OUTCOME_EVENT_RECORD_KIND);
    expect(schema.properties['schemaVersion']?.const).toBe(OUTCOME_EVENT_RECORD_SCHEMA_VERSION);
    expect(schema.required).toEqual(
      expect.arrayContaining(['kind', 'schemaVersion', 'eventIdentity', 'writer', 'event', 'commit']),
    );
    expect(schema.additionalProperties).toBe(true);
  });
});
