import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decorativeCheckers } from '../../../src/queries/cleanup/decorative-checkers.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

describe('decorative-checkers', () => {
  let tempDir: string;
  let db: ScipDatabase;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-decorative-checkers-'));
    const projectRoot = join(tempDir, 'project');
    writeFixtureFiles(projectRoot, {
      // 1. Constant-true validator — always "passes", nothing can fail it.
      'src/constant-true.ts': ['export function validateAlwaysOk(input: unknown): boolean {', '  return true;', '}'],
      // 2. Throwing validator — has a real failure exit.
      'src/throwing.ts': [
        'export function validateRealCheck(input: unknown): void {',
        '  if (!input) {',
        "    throw new Error('bad input');",
        '  }',
        '}',
      ],
      // 3. Boolean-expression predicate — CAN fail, must not fire.
      'src/predicate-expr.ts': [
        'export function isValidShape(a: boolean, b: boolean): boolean {',
        '  return a && b;',
        '}',
      ],
      // 4. Delegating validator resolving (one hop) to a throwing implementation.
      'src/delegator.ts': [
        "import { validateRealCheck } from './throwing.js';",
        'export function validateViaDelegate(input: unknown): void {',
        '  return validateRealCheck(input);',
        '}',
      ],
      // 5. Early-exit-plus-real-path: config-disabled guard followed by a real check.
      'src/config-gated.ts': [
        'export function validateWhenEnabled(input: unknown, enabled: boolean): boolean {',
        '  if (!enabled) return true;',
        '  if (!input) return false;',
        '  return true;',
        '}',
      ],
    });

    const dbPath = join(tempDir, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/constant-true.ts')
      .document(2, 'typescript', 'src/throwing.ts')
      .document(3, 'typescript', 'src/predicate-expr.ts')
      .document(4, 'typescript', 'src/delegator.ts')
      .document(5, 'typescript', 'src/config-gated.ts')
      .symbol(1, 'scip-typescript npm fixture 1.0.0 src/`constant-true.ts`/validateAlwaysOk().', 'validateAlwaysOk', 12)
      .symbol(2, 'scip-typescript npm fixture 1.0.0 src/`throwing.ts`/validateRealCheck().', 'validateRealCheck', 12)
      .symbol(3, 'scip-typescript npm fixture 1.0.0 src/`predicate-expr.ts`/isValidShape().', 'isValidShape', 12)
      .symbol(
        4,
        'scip-typescript npm fixture 1.0.0 src/`delegator.ts`/validateViaDelegate().',
        'validateViaDelegate',
        12,
      )
      .symbol(
        5,
        'scip-typescript npm fixture 1.0.0 src/`config-gated.ts`/validateWhenEnabled().',
        'validateWhenEnabled',
        12,
      )
      .definition(1, 1, 1, 0, 0, 2, 1)
      .definition(2, 2, 2, 0, 0, 4, 1)
      .definition(3, 3, 3, 0, 0, 2, 1)
      .definition(4, 4, 4, 1, 0, 3, 1)
      .definition(5, 5, 5, 0, 0, 4, 1)
      .write();

    db = new ScipDatabase({ dbPath, projectRoot, indexPath: join(tempDir, 'index.scip') });
  });

  afterAll(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('fires on a constant-true validator', () => {
    const findings = decorativeCheckers(db);
    const hit = findings.find((f) => f.shortName.includes('validateAlwaysOk'));
    expect(hit).toBeDefined();
    expect(hit?.resolvedVia).toBe('direct');
  });

  it('does not fire on a throwing validator', () => {
    const findings = decorativeCheckers(db);
    expect(findings.some((f) => f.shortName.includes('validateRealCheck'))).toBe(false);
  });

  it('does not fire on a boolean-expression predicate', () => {
    const findings = decorativeCheckers(db);
    expect(findings.some((f) => f.shortName.includes('isValidShape'))).toBe(false);
  });

  it('does not fire on a delegating validator whose one-hop target throws', () => {
    const findings = decorativeCheckers(db);
    expect(findings.some((f) => f.shortName.includes('validateViaDelegate'))).toBe(false);
  });

  it('does not fire when an early constant-true exit is followed by a real failure path', () => {
    const findings = decorativeCheckers(db);
    expect(findings.some((f) => f.shortName.includes('validateWhenEnabled'))).toBe(false);
  });
});

// Positive control for the one-hop delegate path: without actually resolving
// and judging the delegate's body, a delegating wrapper over a *decorative*
// implementation would slip through undetected (the wrapper's own body is
// trivially failure-free by construction). This is the mirror image of the
// "resolves to a throwing implementation" case above.
describe('decorative-checkers — delegate resolves to a decorative implementation', () => {
  let tempDir: string;
  let db: ScipDatabase;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-decorative-checkers-delegate-'));
    const projectRoot = join(tempDir, 'project');
    writeFixtureFiles(projectRoot, {
      'src/decorative-impl.ts': ['export function validateImpl(input: unknown): boolean {', '  return true;', '}'],
      'src/wrapper.ts': [
        "import { validateImpl } from './decorative-impl.js';",
        'export function validateWrapper(input: unknown): boolean {',
        '  return validateImpl(input);',
        '}',
      ],
    });

    const dbPath = join(tempDir, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/decorative-impl.ts')
      .document(2, 'typescript', 'src/wrapper.ts')
      .symbol(1, 'scip-typescript npm fixture 1.0.0 src/`decorative-impl.ts`/validateImpl().', 'validateImpl', 12)
      .symbol(2, 'scip-typescript npm fixture 1.0.0 src/`wrapper.ts`/validateWrapper().', 'validateWrapper', 12)
      .definition(1, 1, 1, 0, 0, 2, 1)
      .definition(2, 2, 2, 1, 0, 3, 1)
      .write();

    db = new ScipDatabase({ dbPath, projectRoot, indexPath: join(tempDir, 'index.scip') });
  });

  afterAll(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('fires on the wrapper, resolved via its one-hop decorative delegate', () => {
    const findings = decorativeCheckers(db);
    const hit = findings.find((f) => f.shortName.includes('validateWrapper'));
    expect(hit).toBeDefined();
    expect(hit?.resolvedVia).toBe('one-hop-delegate');
    expect(hit?.delegateTarget).toContain('validateImpl');
  });
});

// Dogfood regressions (found running this detector against this repo's own
// index, before it ever shipped).
describe('decorative-checkers — dogfood regressions', () => {
  let tempDir: string;
  let db: ScipDatabase;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-decorative-checkers-dogfood-'));
    const projectRoot = join(tempDir, 'project');
    writeFixtureFiles(projectRoot, {
      // Bug 1: stripCommentsAndStrings's Python-style `#.*$` line-comment
      // stripper masked a regex literal containing a literal `#` (matching a
      // Rust attribute), eating the return expression *and* its terminating
      // `;` — the real predicate looked like it had zero return statements.
      'src/hash-in-regex.ts': [
        'export function isRustAllowDeadCodeAttr(attrText: string): boolean {',
        '  return /#\\[\\s*allow\\s*\\(\\s*dead_code\\s*\\)/.test(attrText);',
        '}',
      ],
      // Bug 2: the naive `[^;{}]*` return-expression capture truncated at
      // the first `{` it saw, so any return statement containing a template
      // literal interpolation (`${...}`) or object/array literal vanished
      // from analysis entirely — a real dynamic predicate looked decorative.
      'src/template-interpolation.ts': [
        'export function hasIdentifierUsage(body: string, identifier: string): boolean {',
        "  return new RegExp(`\\\\b${identifier}\\\\b`, 'm').test(body);",
        '}',
      ],
    });

    const dbPath = join(tempDir, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/hash-in-regex.ts')
      .document(2, 'typescript', 'src/template-interpolation.ts')
      .symbol(
        1,
        'scip-typescript npm fixture 1.0.0 src/`hash-in-regex.ts`/isRustAllowDeadCodeAttr().',
        'isRustAllowDeadCodeAttr',
        12,
      )
      .symbol(
        2,
        'scip-typescript npm fixture 1.0.0 src/`template-interpolation.ts`/hasIdentifierUsage().',
        'hasIdentifierUsage',
        12,
      )
      .definition(1, 1, 1, 0, 0, 2, 1)
      .definition(2, 2, 2, 0, 0, 2, 1)
      .write();

    db = new ScipDatabase({ dbPath, projectRoot, indexPath: join(tempDir, 'index.scip') });
  });

  afterAll(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not flag a predicate whose only return is a regex literal containing `#`', () => {
    const findings = decorativeCheckers(db);
    expect(findings.some((f) => f.shortName.includes('isRustAllowDeadCodeAttr'))).toBe(false);
  });

  it('does not flag a predicate whose return expression contains a template-literal interpolation', () => {
    const findings = decorativeCheckers(db);
    expect(findings.some((f) => f.shortName.includes('hasIdentifierUsage'))).toBe(false);
  });
});
