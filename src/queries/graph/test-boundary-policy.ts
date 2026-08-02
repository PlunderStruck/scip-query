/**
 * Boundary policy for test files.
 *
 * Test files are not SCIP-indexed — the TypeScript project excludes them — so
 * they sit outside every architecture rule: a test can import across any
 * boundary and nothing notices. That is the largest hole in boundary
 * enforcement, because tests are where implementation details leak first.
 *
 * The check does not need the index. `getSourceText` reads from disk, so a
 * test's imports can be parsed and resolved with the same resolver production
 * code uses.
 *
 * A test is judged against the boundary of the code it covers, found by path
 * mirroring (`tests/a/b.test.ts` covers `src/a/b.ts`) against files that really
 * exist. A test with no single locatable subject is cross-cutting and is not
 * judged at all. Reaching further than its subject may reach is the violation: it means the test depends on
 * something the code under test is forbidden to depend on, so the test will
 * survive a refactor that the architecture is supposed to force.
 */
import { listGlobMatches } from '../../analysis/glob-match.js';
import type { ArchitectureConfig } from '../../domain/config-types.js';
import { getSourceImports } from '../../language-parsers/index.js';
import type { ScipDatabase } from '../../storage/db.js';

// scip-query: ignore-stale -- Architecture finding shape is consumed by the aggregate architecture report.
export interface TestBoundaryViolation {
  testFile: string;
  /** Boundary of the code this test covers, or null when no subject was found. */
  ownerBoundary: string | null;
  importedFile: string;
  importedBoundary: string;
  reason: 'outside-owner-policy' | 'unowned-test';
}

const TEST_SUFFIX = /\.(test|spec)\.(ts|tsx|js|jsx|mts|cts)$/;

// Discovering test roots walks the filesystem, and architecture() is called by
// health and focused architecture checks, so the walk is memoized per project root.
const TEST_FILE_CACHE = new Map<string, string[]>();

/**
 * Test files that import outside what their subject's boundary may reach.
 *
 * Returns an empty list when `testPaths` is unset — the rule is opt-in, because
 * a project whose tests deliberately compose across boundaries would otherwise
 * fail on upgrade.
 */
export function testBoundaryViolations(
  db: ScipDatabase,
  config: ArchitectureConfig | undefined,
  boundaryOf: (file: string) => string | null,
  isSourceFile: (file: string) => boolean,
): TestBoundaryViolation[] {
  if (!config?.testPaths?.length) return [];
  const reachable = testReachableBoundaries(config);
  const violations: TestBoundaryViolation[] = [];

  for (const testFile of testFiles(db, config.testPaths)) {
    const subject = subjectFor(db, testFile, isSourceFile);
    const ownerBoundary = subject ? boundaryOf(subject) : null;
    // A test whose subject cannot be located is not judged: guessing an owner
    // would report every import it makes, which is noise rather than a finding.
    if (!ownerBoundary) continue;

    for (const parsed of getSourceImports(db, testFile)) {
      const target = parsed.sourcePath;
      if (!target) continue;
      const importedBoundary = boundaryOf(target);
      if (!importedBoundary) continue;

      if (importedBoundary === ownerBoundary) continue;
      if (reachable.get(ownerBoundary)?.has(importedBoundary)) continue;
      violations.push({
        testFile,
        ownerBoundary,
        importedFile: target,
        importedBoundary,
        reason: 'outside-owner-policy',
      });
    }
  }

  return dedupe(violations);
}

/**
 * What each boundary's tests may import.
 *
 * A test legitimately composes more than its subject does. It may reach
 * anything the subject can reach *transitively* — an assertion often needs a
 * type three layers down — and it may reach any boundary that can reach the
 * subject, because a consumer is the natural driver for exercising it. What is
 * left over is a test coupled to code unrelated to what it covers in either
 * direction, which is the case worth reporting.
 */
function testReachableBoundaries(config: ArchitectureConfig): Map<string, Set<string>> {
  const allowed = config.allowedDependencies ?? {};
  const names = config.boundaries.map((boundary) => boundary.name);

  const downstream = new Map<string, Set<string>>();
  const walk = (name: string, into: Set<string>): void => {
    for (const next of allowed[name] ?? []) {
      if (into.has(next)) continue;
      into.add(next);
      walk(next, into);
    }
  };
  for (const name of names) {
    const into = new Set<string>();
    walk(name, into);
    downstream.set(name, into);
  }

  const result = new Map<string, Set<string>>();
  for (const name of names) {
    const set = new Set(downstream.get(name));
    for (const other of names) {
      if (other !== name && downstream.get(other)?.has(name)) set.add(other);
    }
    result.set(name, set);
  }
  return result;
}

function testFiles(db: ScipDatabase, patterns: readonly string[]): string[] {
  const key = `${db.config.projectRoot}\0${patterns.join('\0')}`;
  const cached = TEST_FILE_CACHE.get(key);
  if (cached) return cached;
  const found = new Set<string>();
  for (const pattern of patterns) {
    for (const path of listGlobMatches(db.config.projectRoot, pattern)) {
      if (TEST_SUFFIX.test(path)) found.add(path);
    }
  }
  const result = [...found].sort();
  TEST_FILE_CACHE.set(key, result);
  return result;
}

/**
 * The source file a test covers, by mirroring its path: the leading `tests/`
 * segment becomes `src/` and the `.test`/`.spec` infix is dropped. Returns null
 * when the mirrored path is not itself a plausible source path, which keeps the
 * rule silent for integration tests that cover no single module.
 */
function subjectFor(db: ScipDatabase, testFile: string, isSourceFile: (file: string) => boolean): string | null {
  const mirrored = testFile.replace(/^tests\//, 'src/').replace(/\.(test|spec)\.(\w+)$/, '.$2');
  // The mirrored path must be a real source file. A boundary glob matches paths
  // that do not exist, so trusting it would attribute a cross-cutting test to
  // whichever directory it happens to sit in.
  if (mirrored !== testFile && isSourceFile(mirrored)) return mirrored;

  // Directories are reorganized more often than files are renamed, so fall back
  // to the unique source file sharing the test's basename. Ambiguity means no
  // subject: two candidates cannot both be the thing under test.
  const base = testFile
    .split('/')
    .pop()!
    .replace(/\.(test|spec)\.(\w+)$/, '.$2');
  const matches = getSourceImports(db, testFile)
    .map((parsed) => parsed.sourcePath)
    .filter((path): path is string => !!path && isSourceFile(path) && path.split('/').pop() === base);
  return matches.length === 1 ? matches[0]! : null;
}

function dedupe(violations: readonly TestBoundaryViolation[]): TestBoundaryViolation[] {
  const seen = new Map<string, TestBoundaryViolation>();
  for (const violation of violations) {
    const key = `${violation.testFile}\0${violation.importedBoundary}`;
    if (!seen.has(key)) seen.set(key, violation);
  }
  return [...seen.values()].sort(
    (a, b) => a.testFile.localeCompare(b.testFile) || a.importedBoundary.localeCompare(b.importedBoundary),
  );
}
