/**
 * Match the repository's deliberately narrow path-glob vocabulary: literal
 * paths, one-level `*`, or recursive `**` suffixes.
 */
export function matchesPathGlob(pattern: string, relativePath: string): boolean {
  const normalizedPattern = normalizePathGlobValue(pattern);
  const normalizedPath = normalizePathGlobValue(relativePath);

  if (normalizedPattern.endsWith('/**')) {
    const prefix = normalizedPattern.slice(0, -3);
    return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
  }
  if (normalizedPattern.endsWith('/*')) {
    const prefix = normalizedPattern.slice(0, -2);
    if (!normalizedPath.startsWith(`${prefix}/`)) return false;
    const rest = normalizedPath.slice(prefix.length + 1);
    return rest.length > 0 && !rest.includes('/');
  }
  if (normalizedPattern === '**') return true;
  if (normalizedPattern === '*') return normalizedPath.length > 0 && !normalizedPath.includes('/');
  return normalizedPattern === normalizedPath;
}

function normalizePathGlobValue(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}
