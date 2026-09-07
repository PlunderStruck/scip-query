/**
 * A project-input change journal is a bounded record of filesystem events
 * observed after one accepted SQLite generation. The generation identity and
 * completeness flag are what let a reindexer use the paths as authoritative
 * invalidation input instead of as advisory log text.
 */
export const PROJECT_INPUT_CHANGE_JOURNAL_VERSION = 1;
export const MAX_PROJECT_INPUT_CHANGE_ENTRIES = 1_024;
export const MAX_PROJECT_INPUT_CHANGE_JOURNAL_BYTES = 64 * 1_024;

export type ProjectInputChangeKind = 'add' | 'change' | 'delete';

export interface ProjectInputChangeEntry {
  /** Normalized project-relative path. */
  path: string;
  kind: ProjectInputChangeKind;
}

export interface ProjectInputChangeJournal {
  version: typeof PROJECT_INPUT_CHANGE_JOURNAL_VERSION;
  /** Immutable SQLite generation from which these changes were observed. */
  baseGeneration: string | null;
  /** False means the paths are diagnostic only and must not drive incremental reuse. */
  complete: boolean;
  /** Stable explanation for an incomplete journal. */
  incompleteReason?: string;
  entries: ProjectInputChangeEntry[];
}

export function serializeProjectInputChangeJournal(journal: ProjectInputChangeJournal): string | undefined {
  const serialized = JSON.stringify(journal);
  return Buffer.byteLength(serialized) <= MAX_PROJECT_INPUT_CHANGE_JOURNAL_BYTES ? serialized : undefined;
}

export function parseProjectInputChangeJournal(value: string | undefined): ProjectInputChangeJournal | undefined {
  if (!value || Buffer.byteLength(value) > MAX_PROJECT_INPUT_CHANGE_JOURNAL_BYTES) return undefined;
  try {
    return decodeProjectInputChangeJournal(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

type JournalRecord = Omit<ProjectInputChangeJournal, 'entries'> & { entries: unknown[] };

function isJournalRecord(value: unknown): value is JournalRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<Record<keyof ProjectInputChangeJournal, unknown>>;
  return (
    record.version === PROJECT_INPUT_CHANGE_JOURNAL_VERSION &&
    (record.baseGeneration === null || typeof record.baseGeneration === 'string') &&
    typeof record.complete === 'boolean' &&
    isBoundedJournalEntries(record.entries) &&
    (record.incompleteReason === undefined || typeof record.incompleteReason === 'string')
  );
}

function isBoundedJournalEntries(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length <= MAX_PROJECT_INPUT_CHANGE_ENTRIES;
}

function decodeJournalEntry(value: unknown): ProjectInputChangeEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as { path?: unknown; kind?: unknown };
  if (typeof candidate.path !== 'string' || !isProjectRelativeJournalPath(candidate.path)) return undefined;
  if (candidate.kind !== 'add' && candidate.kind !== 'change' && candidate.kind !== 'delete') return undefined;
  return { path: candidate.path, kind: candidate.kind };
}

function decodeUniqueJournalEntries(values: unknown[]): ProjectInputChangeEntry[] | undefined {
  const entries: ProjectInputChangeEntry[] = [];
  const paths = new Set<string>();
  for (const value of values) {
    const entry = decodeJournalEntry(value);
    if (!entry || paths.has(entry.path)) return undefined;
    paths.add(entry.path);
    entries.push(entry);
  }
  return entries;
}

function hasConsistentJournalCompleteness(record: JournalRecord): boolean {
  if (record.complete) return record.incompleteReason === undefined;
  return record.incompleteReason !== undefined && record.incompleteReason.trim() !== '';
}

export function decodeProjectInputChangeJournal(value: unknown): ProjectInputChangeJournal | undefined {
  if (!isJournalRecord(value)) return undefined;
  const entries = decodeUniqueJournalEntries(value.entries);
  if (!entries || !hasConsistentJournalCompleteness(value)) return undefined;
  return {
    version: PROJECT_INPUT_CHANGE_JOURNAL_VERSION,
    baseGeneration: value.baseGeneration,
    complete: value.complete,
    ...(value.incompleteReason === undefined ? {} : { incompleteReason: value.incompleteReason }),
    entries,
  };
}

function isProjectRelativeJournalPath(path: string): boolean {
  if (!path || path.includes('\0') || path.includes('\\')) return false;
  if (path.startsWith('/') || /^[A-Za-z]:\//.test(path)) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}
