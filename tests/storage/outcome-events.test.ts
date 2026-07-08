import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FindingOutcomeRecord } from '../../src/queries/health/finding-outcome-ledger.js';
import {
  appendOutcomeEvents,
  dedupeEvents,
  deriveOutcomeEvents,
  headCommit,
  ledgerDirPath,
  ledgerFilePath,
  readOutcomeEvents,
  type OutcomeEvent,
} from '../../src/storage/outcome-events.js';

const roots: string[] = [];

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'scipq-events-'));
  roots.push(root);
  return root;
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
});

describe('append/read round trip', () => {
  it('persists events, creates the union-merge gitattributes, and reads them back', () => {
    const root = createRoot();
    const events: OutcomeEvent[] = [
      { ts: 1, check: 'echo', findingId: 'SQAAA', event: 'caught', commit: 'c1', symbol: 'sym#a' },
      { ts: 2, check: 'echo', findingId: 'SQAAA', event: 'resolved', commit: 'c2' },
    ];
    appendOutcomeEvents(root, events);

    expect(readOutcomeEvents(root)).toEqual(events);
    expect(readFileSync(join(ledgerDirPath(root), '.gitattributes'), 'utf-8')).toContain('events.jsonl merge=union');
  });

  it('appending nothing writes nothing', () => {
    const root = createRoot();
    appendOutcomeEvents(root, []);
    expect(readOutcomeEvents(root)).toEqual([]);
  });

  it('preserves an existing gitattributes and appends the union entry once', () => {
    const root = createRoot();
    appendOutcomeEvents(root, [{ ts: 1, check: 'echo', findingId: 'SQAAA', event: 'caught', commit: null }]);
    appendOutcomeEvents(root, [{ ts: 2, check: 'echo', findingId: 'SQBBB', event: 'caught', commit: null }]);
    const attributes = readFileSync(join(ledgerDirPath(root), '.gitattributes'), 'utf-8');
    expect(attributes.match(/merge=union/g)).toHaveLength(1);
  });

  it('skips malformed lines and unknown shapes on read', () => {
    const root = createRoot();
    appendOutcomeEvents(root, [{ ts: 1, check: 'echo', findingId: 'SQAAA', event: 'caught', commit: null }]);
    appendFileSync(ledgerFilePath(root), 'not json\n{"ts":"wrong types"}\n{"half a line');

    const read = readOutcomeEvents(root);
    expect(read).toHaveLength(1);
    expect(read[0].findingId).toBe('SQAAA');
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
});

describe('headCommit', () => {
  it('returns the HEAD sha inside a git repo and null outside one', () => {
    const root = createRoot();
    expect(headCommit(root)).toBeNull();

    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync(
      'git',
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init', '--quiet'],
      {
        cwd: root,
      },
    );
    writeFileSync(join(root, 'file.txt'), 'x');
    expect(headCommit(root)).toMatch(/^[0-9a-f]{40}$/);
  });
});
