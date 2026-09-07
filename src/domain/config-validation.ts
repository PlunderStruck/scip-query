/** Validate optional configuration flags without changing diagnostic order. */
export function validateOptionalBoolean(
  value: unknown,
  path: string,
  diagnostics: Array<{ level: 'error' | 'warning'; path: string; message: string }>,
): void {
  if (value !== undefined && typeof value !== 'boolean') {
    diagnostics.push({ level: 'error', path, message: 'Must be a boolean.' });
  }
}
