/** Encode a versioned cursor payload without imposing command-specific fields. */
export function encodeCursorPayload(payload: object): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}
