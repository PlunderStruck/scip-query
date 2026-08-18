import { describe, expect, it } from 'vitest';
import {
  PROJECT_INPUT_CHANGE_JOURNAL_VERSION,
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
