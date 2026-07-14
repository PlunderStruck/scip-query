import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FindingOutcomeRecord } from '../../src/queries/health/finding-outcome-ledger.js';
import {
  appendOutcomeEvents,
  dedupeEvents,
  deriveOutcomeEvents,
  gitWorktreeIsClean,
  headCommit,
  OUTCOME_EVENTS_DIR,
  readOutcomeEvents,
  resolveGitCommit,
  type OutcomeEvent,
} from '../../src/storage/outcome-events.js';

const roots: string[] = [];

function outcomeEventsDirPath(root: string): string {
  return join(root, OUTCOME_EVENTS_DIR);
}

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
    appendOutcomeEvents(root, events);

    expect(readOutcomeEvents(root)).toEqual(events);
    const files = readdirSync(outcomeEventsDirPath(root));
    expect(files).toHaveLength(2);
    expect(files.every((file) => /^\d+-[0-9A-F]{16}\.json$/.test(file))).toBe(true);
  });

  it('appending nothing writes nothing', () => {
    const root = createRoot();
    appendOutcomeEvents(root, []);
    expect(readOutcomeEvents(root)).toEqual([]);
    expect(existsSync(outcomeEventsDirPath(root))).toBe(false);
  });

  it('treats an exact replay as an idempotent write', () => {
    const root = createRoot();
    const event: OutcomeEvent = { ts: 1, check: 'echo', findingId: 'SQAAA', event: 'caught', commit: null };
    appendOutcomeEvents(root, [event]);
    appendOutcomeEvents(root, [event]);

    expect(readdirSync(outcomeEventsDirPath(root))).toHaveLength(1);
    expect(readOutcomeEvents(root)).toEqual([event]);
  });

  it('keeps separate files for distinct observations and dedupes the fact to the earliest timestamp', () => {
    const root = createRoot();
    appendOutcomeEvents(root, [
      { ts: 9, check: 'echo', findingId: 'SQAAA', event: 'caught', commit: 'c1' },
      { ts: 3, check: 'echo', findingId: 'SQAAA', event: 'caught', commit: 'c1' },
    ]);

    expect(readdirSync(outcomeEventsDirPath(root))).toHaveLength(2);
    expect(readOutcomeEvents(root)).toEqual([
      { ts: 3, check: 'echo', findingId: 'SQAAA', event: 'caught', commit: 'c1' },
    ]);
  });

  it('skips malformed JSON files and unknown shapes on read', () => {
    const root = createRoot();
    const dir = outcomeEventsDirPath(root);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'broken.json'), '{"half a file"');
    writeFileSync(join(dir, 'wrong-shape.json'), '{"ts":"wrong types"}');
    writeFileSync(join(dir, 'notes.txt'), 'ignored');
    appendOutcomeEvents(root, [{ ts: 1, check: 'echo', findingId: 'SQAAA', event: 'caught', commit: null }]);

    const read = readOutcomeEvents(root);
    expect(read).toHaveLength(1);
    expect(read[0].findingId).toBe('SQAAA');
  });

  it('reads a mixed legacy/current ledger and migrates legacy records on the next append', () => {
    const root = createRoot();
    appendOutcomeEvents(root, [{ ts: 9, check: 'echo', findingId: 'SQAAA', event: 'caught', commit: 'c1' }]);

    const legacyDir = join(root, '.scipquery', 'ledger');
    const legacyPath = join(legacyDir, 'events.jsonl');
    const attributesPath = join(legacyDir, '.gitattributes');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      legacyPath,
      [
        JSON.stringify({ ts: 3, check: 'echo', findingId: 'SQAAA', event: 'caught', commit: 'c1' }),
        JSON.stringify({ ts: 5, check: 'new-dead', findingId: 'SQBBB', event: 'caught', commit: 'c2' }),
        'not json',
      ].join('\n'),
    );
    writeFileSync(attributesPath, '*.bin binary\nevents.jsonl merge=union\n');

    expect(readOutcomeEvents(root).map((event) => event.ts)).toEqual([3, 5]);

    appendOutcomeEvents(root, []);

    expect(existsSync(legacyPath)).toBe(false);
    expect(readFileSync(attributesPath, 'utf-8')).toBe('*.bin binary\n');
    expect(readOutcomeEvents(root).map((event) => event.ts)).toEqual([3, 5]);
    expect(readdirSync(outcomeEventsDirPath(root))).toHaveLength(3);
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
    expect(resolveGitCommit(root, 'HEAD')).toBe(headCommit(root));
    expect(gitWorktreeIsClean(root)).toBe(false);
    execFileSync('git', ['add', 'file.txt'], { cwd: root });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'file', '--quiet'], {
      cwd: root,
    });
    expect(gitWorktreeIsClean(root)).toBe(true);
  });
});
