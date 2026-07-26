import type { ScipDatabase } from '../storage/db.js';

interface ResultCursorPayload {
  version: 1;
  command: string;
  target: string;
  offset: number;
  indexGeneration: string;
}

export function indexGenerationIdentity(db: ScipDatabase): string {
  return db.generation.identity;
}

export function encodeResultCursor(payload: Omit<ResultCursorPayload, 'version'>): string {
  return Buffer.from(JSON.stringify({ version: 1, ...payload } satisfies ResultCursorPayload), 'utf8').toString(
    'base64url',
  );
}

export function decodeResultCursor(
  cursor: string,
  expected: { command: string; target: string; indexGeneration: string },
): ResultCursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid result cursor. Run the command again without --cursor.');
  }
  if (!isResultCursorPayload(parsed)) {
    throw new Error('Invalid result cursor. Run the command again without --cursor.');
  }
  if (parsed.command !== expected.command || parsed.target !== expected.target) {
    throw new Error('This cursor belongs to a different command or target. Run again without --cursor.');
  }
  if (parsed.indexGeneration !== expected.indexGeneration) {
    throw new Error('The index changed after this cursor was issued. Run again without --cursor.');
  }
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
