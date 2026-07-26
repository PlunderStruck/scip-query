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

/** Narrows a decoded value to a record whose values are strings or null. */
export function isStringOrNullRecord(value: unknown): value is Record<string, string | null> {
  return isRecordObject(value) && Object.values(value).every((entry) => typeof entry === 'string' || entry === null);
}

/** True only for finite integers at or above zero. */
export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** True only for finite integers above zero. */
export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** True only for finite numbers at or above zero. */
export function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
