import { normalizePathSeparators as normalizePath } from '../../domain/path-normalization.js';

/**
 * A file kind is a source-path role distinguished by the convention that
 * makes a file an executable boundary, re-export surface, worker, test, or
 * ordinary implementation. It is intentionally derived from paths alone.
 */
export type FileKind = 'entry' | 'barrel' | 'worker' | 'test' | 'source';

/** Paths reserved for installed dependencies, build products and local tool state. Existence is not implied. */
export function isManagedOutputPath(file: string): boolean {
  return /(^|\/)(node_modules|dist|build|coverage|\.git|\.scipquery|\.next|\.nuxt|\.turbo|\.cache)(\/|$)/.test(file);
}

/** Rank file kinds for search and inspection presentation: implementation first, tests last. */
export function fileKindRank(kind: FileKind): number {
  switch (kind) {
    case 'entry':
    case 'source':
    case 'worker':
      return 0;
    case 'barrel':
      return 1;
    case 'test':
      return 2;
  }
}

/** Classify a source path by its structural role without consulting project state. */
export function classifyFile(file: string): FileKind {
  const normalized = normalizePath(file);
  if (matchesTestPattern(normalized)) return 'test';
  if (isWorkerPath(normalized)) return 'worker';
  if (isStructuralEntryPath(normalized)) return 'entry';
  if (isBarrelPath(normalized)) return 'barrel';
  return 'source';
}

const TEST_PATH_PATTERNS = [
  /(?:^|\/)(?:e2e|cypress|playwright)\//i,
  /\.(?:test|spec)\.[a-z0-9]+$/i,
  /(?:^|\/)(?:_)?test_[^/]+$/i,
  /(?:^|\/)spec_[^/]+$/i,
  /(?:^|\/)[^/]+_test\.[a-z0-9]+$/i,
  /(?:^|\/)[^/]+_tests\.rs$/i,
  /(?:^|\/)tests\.rs$/i,
  /(?:^|\/)[^/]+_spec\.[a-z0-9]+$/i,
  /(?:^|\/)__tests__\//i,
  /(?:^|\/)test\//i,
  /(?:^|\/)tests\//i,
  /(?:^|\/)__fixtures__\//i,
  /(?:^|\/)__mocks__\//i,
  /(?:^|\/)test-support\//i,
  /(?:^|\/)test-utils\//i,
  /(?:^|\/)testing\//i,
];

function matchesTestPattern(normalized: string): boolean {
  return TEST_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isWorkerPath(normalized: string): boolean {
  return /(?:^|\/)[^/]*worker\.(?:ts|tsx|js|mjs|cjs|rs|py|go)$/.test(normalized);
}

function isStructuralEntryPath(normalized: string): boolean {
  const segments = normalized.split('/');
  const basename = segments[segments.length - 1] ?? normalized;

  if (
    basename === 'cli.ts' ||
    basename === 'cli.js' ||
    basename === 'postinstall.ts' ||
    basename === 'postinstall.js' ||
    basename === 'main.ts' ||
    basename === 'main.js' ||
    basename === 'main.rs' ||
    basename === 'main.go' ||
    basename === 'main.py' ||
    basename === 'build.rs' ||
    basename === 'lib.rs'
  ) {
    return true;
  }

  if (/\bsrc\/bin\/[^/]+\.rs$/.test(normalized)) return true;
  if (/(?:^|\/)examples\/[^/]+\.rs$/.test(normalized)) return true;
  if (/(?:^|\/)tests\/[^/]+\.rs$/.test(normalized)) return true;
  if (/(?:^|\/)benches\/[^/]+\.rs$/.test(normalized)) return true;

  if (basename === 'index.ts' || basename === 'index.js') {
    if (/(?:^|\/)(?:apps|services)\/[^/]+\/src\/index\.(?:ts|js)$/.test(normalized)) return true;
    return segments.length <= 2;
  }

  return false;
}

function isBarrelPath(normalized: string): boolean {
  return (
    normalized === 'index.ts' ||
    normalized === 'index.js' ||
    normalized.endsWith('/index.ts') ||
    normalized.endsWith('/index.js') ||
    normalized.endsWith('/mod.rs') ||
    normalized.endsWith('/__init__.py')
  );
}
