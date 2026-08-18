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

export function decodeProjectInputChangeJournal(value: unknown): ProjectInputChangeJournal | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as {
    version?: unknown;
    baseGeneration?: unknown;
    complete?: unknown;
    incompleteReason?: unknown;
    entries?: unknown;
  };
  if (
    record.version !== PROJECT_INPUT_CHANGE_JOURNAL_VERSION ||
    (record.baseGeneration !== null && typeof record.baseGeneration !== 'string') ||
    typeof record.complete !== 'boolean' ||
    !Array.isArray(record.entries) ||
    record.entries.length > MAX_PROJECT_INPUT_CHANGE_ENTRIES ||
    (record.incompleteReason !== undefined && typeof record.incompleteReason !== 'string')
  ) {
    return undefined;
  }

  const entries: ProjectInputChangeEntry[] = [];
  const paths = new Set<string>();
  for (const entry of record.entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
    const candidate = entry as { path?: unknown; kind?: unknown };
    if (
      typeof candidate.path !== 'string' ||
      !isProjectRelativeJournalPath(candidate.path) ||
      (candidate.kind !== 'add' && candidate.kind !== 'change' && candidate.kind !== 'delete') ||
      paths.has(candidate.path)
    ) {
      return undefined;
    }
    paths.add(candidate.path);
    entries.push({ path: candidate.path, kind: candidate.kind });
  }

  if (record.complete && record.incompleteReason !== undefined) return undefined;
  if (!record.complete && (!record.incompleteReason || record.incompleteReason.trim() === '')) return undefined;
  return {
    version: PROJECT_INPUT_CHANGE_JOURNAL_VERSION,
    baseGeneration: record.baseGeneration,
    complete: record.complete,
    ...(record.incompleteReason === undefined ? {} : { incompleteReason: record.incompleteReason }),
    entries,
  };
}

function isProjectRelativeJournalPath(path: string): boolean {
  if (!path || path.includes('\0') || path.includes('\\')) return false;
  if (path.startsWith('/') || /^[A-Za-z]:\//.test(path)) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}
