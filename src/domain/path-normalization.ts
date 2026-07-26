import { isAbsolute, relative } from 'node:path';

export type ProjectFileFailure =
  | 'empty-path'
  | 'nul-byte'
  | 'absolute-path'
  | 'parent-traversal'
  | 'outside-project'
  | 'not-a-file'
  | 'changed-during-read';

export class UnsafeProjectPathError extends Error {
  readonly code = 'SCIP_QUERY_UNSAFE_PROJECT_PATH';

  constructor(
    readonly relativePath: string,
    readonly reason: ProjectFileFailure,
  ) {
    super(`refusing unsafe project file path ${JSON.stringify(relativePath)} (${reason})`);
    this.name = 'UnsafeProjectPathError';
  }
}

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

export function normalizeSafeProjectRelativePath(candidatePath: string): string {
  if (!candidatePath) throw new UnsafeProjectPathError(candidatePath, 'empty-path');
  if (candidatePath.includes('\0')) throw new UnsafeProjectPathError(candidatePath, 'nul-byte');
  if (
    isAbsolute(candidatePath) ||
    /^[A-Za-z]:/.test(candidatePath) ||
    candidatePath.startsWith('//') ||
    candidatePath.startsWith('\\\\')
  ) {
    throw new UnsafeProjectPathError(candidatePath, 'absolute-path');
  }

  const normalized = normalizeRelativePath(candidatePath);
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new UnsafeProjectPathError(candidatePath, 'parent-traversal');
  }
  if (!normalized || normalized === '.') {
    throw new UnsafeProjectPathError(candidatePath, 'empty-path');
  }
  return normalized;
}
