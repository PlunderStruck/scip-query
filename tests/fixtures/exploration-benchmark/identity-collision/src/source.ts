export function transform(values: string[]): string[] {
  values.push('x');
  return values.slice(1);
}
