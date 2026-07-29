import type { ScipDatabase } from '../storage/db.js';
import { encodeCursorPayload } from './cursor-codec.js';

interface ResultCursorPayload {
  version: 1;
  command: string;
  target: string;
  offset: number;
  indexGeneration: string;
}

// scip-query: ignore-stale -- Shared keyset identity is the stable boundary between cursors and paged results.
export interface ResultKeyset {
  relativePath: string;
  line: number;
}

export type ResultPageProducer = 'source-keyset' | 'complete-only';

export interface ResultKeysetCursorPayload {
  version: 2;
  command: string;
  target: string;
  after: ResultKeyset;
  producer: ResultPageProducer;
  semanticEnrichment: boolean;
  indexGeneration: string;
}

export type CompatibleResultCursorPayload = ResultCursorPayload | ResultKeysetCursorPayload;

export function indexGenerationIdentity(db: ScipDatabase): string {
  return db.generation.identity;
}

export function encodeResultCursor(
  payload: Omit<ResultCursorPayload, 'version'> | Omit<ResultKeysetCursorPayload, 'version'>,
): string {
  return 'after' in payload
    ? encodeCursorPayload({ version: 2, ...payload } satisfies ResultKeysetCursorPayload)
    : encodeCursorPayload({ version: 1, ...payload } satisfies ResultCursorPayload);
}

export function decodeResultCursor(
  cursor: string,
  expected: { command: string; target: string; indexGeneration: string },
): ResultCursorPayload {
  const parsed = parseResultCursor(cursor);
  if (!isResultCursorPayload(parsed)) {
    throw new Error('Invalid result cursor. Run the command again without --cursor.');
  }
  assertCursorInvocation(parsed, expected);
  return parsed;
}

export function decodeCompatibleResultCursor(
  cursor: string,
  expected: { command: string; target: string; indexGeneration: string },
): CompatibleResultCursorPayload {
  const parsed = parseResultCursor(cursor);
  if (!isResultCursorPayload(parsed) && !isResultKeysetCursorPayload(parsed)) {
    throw new Error('Invalid result cursor. Run the command again without --cursor.');
  }
  assertCursorInvocation(parsed, expected);
  return parsed;
}

function isResultCursorPayload(value: unknown): value is ResultCursorPayload {
  if (!value || typeof value !== 'object') return false;
  const cursor = value as Partial<ResultCursorPayload>;
  return (
    cursor.version === 1 &&
    typeof cursor.command === 'string' &&
    typeof cursor.target === 'string' &&
    Number.isSafeInteger(cursor.offset) &&
    (cursor.offset ?? -1) >= 0 &&
    typeof cursor.indexGeneration === 'string' &&
    cursor.indexGeneration.length > 0
  );
}

function isResultKeysetCursorPayload(value: unknown): value is ResultKeysetCursorPayload {
  if (!value || typeof value !== 'object') return false;
  const cursor = value as Partial<ResultKeysetCursorPayload>;
  const after = cursor.after as Partial<ResultKeyset> | undefined;
  return (
    cursor.version === 2 &&
    typeof cursor.command === 'string' &&
    typeof cursor.target === 'string' &&
    !!after &&
    typeof after.relativePath === 'string' &&
    after.relativePath.length > 0 &&
    Number.isSafeInteger(after.line) &&
    (after.line ?? -1) >= 0 &&
    (cursor.producer === 'source-keyset' || cursor.producer === 'complete-only') &&
    typeof cursor.semanticEnrichment === 'boolean' &&
    typeof cursor.indexGeneration === 'string' &&
    cursor.indexGeneration.length > 0
  );
}

function parseResultCursor(cursor: string): unknown {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid result cursor. Run the command again without --cursor.');
  }
}

function assertCursorInvocation(
  cursor: Pick<ResultCursorPayload, 'command' | 'target' | 'indexGeneration'>,
  expected: { command: string; target: string; indexGeneration: string },
): void {
  if (cursor.command !== expected.command || cursor.target !== expected.target) {
    throw new Error('This cursor belongs to a different command or target. Run again without --cursor.');
  }
  if (cursor.indexGeneration !== expected.indexGeneration) {
    throw new Error('The index changed after this cursor was issued. Run again without --cursor.');
  }
}
