import { isAbsolute, relative } from 'node:path';

// scip-query: ignore-wrapper — names the cross-module path-equivalence contract:
// project-relative paths compare after separator and leading-dot normalization.
export function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

// scip-query: ignore-wrapper — single-line but expresses the project-wide
// "always forward-slash paths" contract; replacing call sites would scatter
// the convention. Distinct from normalizeRelativePath above: this does not
// strip a leading "./" (some callers compare paths where that segment is
// significant).
export function normalizePathSeparators(path: string): string {
  return path.replace(/\\/g, '/');
}

export function pathsResolveSame(a: string, b: string): boolean {
  return normalizeRelativePath(a) === normalizeRelativePath(b);
}

/** Whether `candidate` resolves to `root` itself or somewhere beneath it. */
export function isPathInsideProject(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
