import { normalizePathSeparators as normalizePath } from '../../domain/path-normalization.js';

/**
 * A file kind is a source-path role distinguished by the convention that
 * makes a file an executable boundary, re-export surface, worker, test, or
 * ordinary implementation. It is intentionally derived from paths alone.
 */
export type FileKind = 'entry' | 'barrel' | 'worker' | 'test' | 'source';

/** Classify a source path by its structural role without consulting project state. */
export function classifyFile(file: string): FileKind {
  const normalized = normalizePath(file);
  if (matchesTestPattern(normalized)) return 'test';
  if (isWorkerPath(normalized)) return 'worker';
  if (isStructuralEntryPath(normalized)) return 'entry';
  if (isBarrelPath(normalized)) return 'barrel';
  return 'source';
}

function matchesTestPattern(normalized: string): boolean {
  if (/\.(?:test|spec)\.[a-z0-9]+$/i.test(normalized)) return true;
  if (/(?:^|\/)(?:_)?test_[^/]+$/i.test(normalized)) return true;
  if (/(?:^|\/)spec_[^/]+$/i.test(normalized)) return true;
  if (/(?:^|\/)[^/]+_test\.[a-z0-9]+$/i.test(normalized)) return true;
  if (/(?:^|\/)[^/]+_tests\.rs$/i.test(normalized)) return true;
  if (/(?:^|\/)tests\.rs$/i.test(normalized)) return true;
  if (/(?:^|\/)[^/]+_spec\.[a-z0-9]+$/i.test(normalized)) return true;
  if (/(?:^|\/)__tests__\//i.test(normalized)) return true;
  if (/(?:^|\/)test\//i.test(normalized)) return true;
  if (/(?:^|\/)tests\//i.test(normalized)) return true;
  if (/(?:^|\/)__fixtures__\//i.test(normalized)) return true;
  if (/(?:^|\/)__mocks__\//i.test(normalized)) return true;
  if (/(?:^|\/)test-support\//i.test(normalized)) return true;
  if (/(?:^|\/)test-utils\//i.test(normalized)) return true;
  if (/(?:^|\/)testing\//i.test(normalized)) return true;
  return false;
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
