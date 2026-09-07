import { describe, expect, it } from 'vitest';
import {
  PROJECT_INPUT_CHANGE_JOURNAL_VERSION,
  MAX_PROJECT_INPUT_CHANGE_ENTRIES,
  MAX_PROJECT_INPUT_CHANGE_JOURNAL_BYTES,
  decodeProjectInputChangeJournal,
  parseProjectInputChangeJournal,
  serializeProjectInputChangeJournal,
  type ProjectInputChangeJournal,
} from '../../src/domain/project-input-change-journal.js';

describe('project input change journal', () => {
  it('round-trips a complete bounded journal', () => {
    const journal: ProjectInputChangeJournal = {
      version: PROJECT_INPUT_CHANGE_JOURNAL_VERSION,
      baseGeneration: 'generation-a',
      complete: true,
      entries: [
        { path: 'src/a.ts', kind: 'change' },
        { path: 'src/new.ts', kind: 'add' },
      ],
    };

    expect(parseProjectInputChangeJournal(serializeProjectInputChangeJournal(journal))).toEqual(journal);
  });

  it('rejects malformed, absolute, duplicate, and unexplained incomplete journals', () => {
    const base = {
      version: PROJECT_INPUT_CHANGE_JOURNAL_VERSION,
      baseGeneration: 'generation-a',
      complete: true,
    };

    expect(
      parseProjectInputChangeJournal(JSON.stringify({ ...base, entries: [{ path: '../outside.ts', kind: 'change' }] })),
    ).toBeUndefined();
    expect(
      parseProjectInputChangeJournal(
        JSON.stringify({
          ...base,
          entries: [
            { path: 'src/a.ts', kind: 'change' },
            { path: 'src/a.ts', kind: 'delete' },
          ],
        }),
      ),
    ).toBeUndefined();
    expect(parseProjectInputChangeJournal(JSON.stringify({ ...base, complete: false, entries: [] }))).toBeUndefined();
  });
});

describe('journal authority bounds', () => {
  const base = { version: PROJECT_INPUT_CHANGE_JOURNAL_VERSION, baseGeneration: null, complete: true };

  it('accepts exactly the entry bound and rejects one extra distinct path', () => {
    const entries = Array.from({ length: MAX_PROJECT_INPUT_CHANGE_ENTRIES }, (_, i) => ({
      path: `src/${i}.ts`,
      kind: 'change',
    }));
    expect(decodeProjectInputChangeJournal({ ...base, entries })?.entries).toHaveLength(
      MAX_PROJECT_INPUT_CHANGE_ENTRIES,
    );
    expect(
      decodeProjectInputChangeJournal({ ...base, entries: [...entries, { path: 'src/extra.ts', kind: 'add' }] }),
    ).toBeUndefined();
  });

  it.each([
    '/outside.ts',
    'C:/outside.ts',
    'src\\outside.ts',
    'src/../outside.ts',
    'src/./file.ts',
    'src//file.ts',
    'src/file.ts/',
    'src/\0file.ts',
  ])('rejects noncanonical journal path %j', (path) => {
    expect(decodeProjectInputChangeJournal({ ...base, entries: [{ path, kind: 'delete' }] })).toBeUndefined();
  });

  it('requires an explanation only for incomplete journals and preserves its text', () => {
    const incomplete = { ...base, complete: false, incompleteReason: ' queue overflow ', entries: [] };
    expect(decodeProjectInputChangeJournal(incomplete)).toEqual(incomplete);
    expect(decodeProjectInputChangeJournal({ ...incomplete, incompleteReason: '  ' })).toBeUndefined();
    expect(decodeProjectInputChangeJournal({ ...incomplete, complete: true })).toBeUndefined();
    expect(decodeProjectInputChangeJournal({ ...base, incompleteReason: '', entries: [] })).toBeUndefined();
  });

  it('enforces the serialized UTF-8 byte budget', () => {
    const journal = {
      ...base,
      complete: false,
      incompleteReason: 'é'.repeat(MAX_PROJECT_INPUT_CHANGE_JOURNAL_BYTES / 2),
      entries: [],
    };
    expect(JSON.stringify(journal).length).toBeLessThan(MAX_PROJECT_INPUT_CHANGE_JOURNAL_BYTES);
    expect(serializeProjectInputChangeJournal(journal)).toBeUndefined();
    expect(parseProjectInputChangeJournal(JSON.stringify(journal))).toBeUndefined();
  });
});
