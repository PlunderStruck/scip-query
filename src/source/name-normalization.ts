export function pascalCaseSeparated(value: string, separator: RegExp): string {
  return value
    .split(separator)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}
