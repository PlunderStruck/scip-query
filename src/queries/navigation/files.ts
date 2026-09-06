import type { ScipDatabase } from '../../storage/db.js';
import { normalizeSafeProjectRelativePath } from '../../domain/path-normalization.js';
import { repositoryProjectPaths } from '../../source/primitives/repository-text.js';
import { projectFileExists } from '../../source/primitives/project-file-boundary.js';

export interface FileResult {
  relativePath: string;
}

export interface PathMatchesGlobOptions {
  pattern: string;
  relativePath: string;
}

export function files(db: ScipDatabase, pattern: string): FileResult[] {
  return repositoryProjectPaths(db)
    .filter((relativePath) => pathMatchesGlob({ pattern, relativePath }))
    .filter((relativePath) => projectFileExists(db.config.projectRoot, relativePath))
    .map((relativePath) => ({
      relativePath,
    }));
}

export function pathMatchesGlob(options: PathMatchesGlobOptions): boolean;
/**
 * @deprecated Use `pathMatchesGlob({ pattern, relativePath })` so the pattern
 * and candidate path cannot be transposed.
 */
export function pathMatchesGlob(pattern: string, relativePath: string): boolean;
export function pathMatchesGlob(
  optionsOrPattern: PathMatchesGlobOptions | string,
  legacyRelativePath?: string,
): boolean {
  const values =
    typeof optionsOrPattern === 'string'
      ? { pattern: optionsOrPattern, relativePath: legacyRelativePath }
      : optionsOrPattern;
  if (typeof values.pattern !== 'string' || typeof values.relativePath !== 'string') {
    throw new TypeError('pathMatchesGlob requires pattern and relativePath.');
  }
  const pattern = normalizeSafeProjectRelativePath(values.pattern);
  const relativePath = normalizeSafeProjectRelativePath(values.relativePath);
  if (!/[*?]/.test(pattern)) {
    return relativePath.includes(pattern);
  }
  const normalizedPattern = pattern.includes('/') ? pattern : `**/${pattern}`;
  return globSegmentsMatch(normalizedPattern.split('/'), relativePath.split('/'));
}

function globSegmentsMatch(patternSegments: string[], pathSegments: string[]): boolean {
  if (patternSegments.length === 0) return pathSegments.length === 0;
  const [head, ...rest] = patternSegments;
  if (head === '**') {
    return (
      globSegmentsMatch(rest, pathSegments) ||
      (pathSegments.length > 0 && globSegmentsMatch(patternSegments, pathSegments.slice(1)))
    );
  }
  if (pathSegments.length === 0) return false;
  if (!segmentMatches(head ?? '', pathSegments[0] ?? '')) return false;
  return globSegmentsMatch(rest, pathSegments.slice(1));
}

function segmentMatches(pattern: string, segment: string): boolean {
  let expression = '^';
  for (const char of pattern) {
    if (char === '*') {
      expression += '[^/]*';
    } else if (char === '?') {
      expression += '[^/]';
    } else {
      expression += escapeRegexChar(char);
    }
  }
  expression += '$';
  return new RegExp(expression).test(segment);
}

function escapeRegexChar(char: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
}
