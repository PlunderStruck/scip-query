// scip-query: ignore-wrapper — names the cross-module path-equivalence contract:
// project-relative paths compare after separator and leading-dot normalization.
export function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function pathsResolveSame(a: string, b: string): boolean {
  return normalizeRelativePath(a) === normalizeRelativePath(b);
}
