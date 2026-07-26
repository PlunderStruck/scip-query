/**
 * Narrows a decoded record to a non-null object whose members are named
 * fields rather than array positions.
 */
export function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True only for strings that identify a finite JavaScript timestamp. */
export function isValidRecordTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
