/** True only for strings that identify a finite JavaScript timestamp. */
export function isValidRecordTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
