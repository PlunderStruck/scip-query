export function semanticDefinitionsByFile<T extends { relativePath: string }>(
  definitions: ReadonlyArray<T>,
): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const definition of definitions) {
    const bucket = result.get(definition.relativePath) ?? [];
    bucket.push(definition);
    result.set(definition.relativePath, bucket);
  }
  return result;
}
