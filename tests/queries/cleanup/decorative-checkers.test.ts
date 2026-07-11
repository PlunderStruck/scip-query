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
      'src/capability.ts': ['export function hasNativeGit(): boolean {', '  return true;', '}'],
      'src/effect-failure.ts': [
        'export function assertStable(input: unknown) {',
        '  return Effect.gen(function* () {',
        '    if (!input) yield* Effect.fail(new Error("invalid"));',
        '  });',
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
      .document(6, 'typescript', 'src/capability.ts')
      .document(7, 'typescript', 'src/effect-failure.ts')
      .symbol(1, 'scip-typescript npm fixture 1.0.0 src/`constant-true.ts`/validateAlwaysOk().', 'validateAlwaysOk', 12)
      .symbol(2, 'scip-typescript npm fixture 1.0.0 src/`throwing.ts`/validateRealCheck().', 'validateRealCheck', 12)
      .symbol(3, 'scip-typescript npm fixture 1.0.0 src/`predicate-expr.ts`/isValidShape().', 'isValidShape', 12)
      .symbol(
        4,
        'scip-typescript npm fixture 1.0.0 src/`delegator.ts`/validateViaDelegate().',
        'validateViaDelegate',
        12,
      )
      .symbol(6, 'scip-typescript npm fixture 1.0.0 src/`capability.ts`/hasNativeGit().', 'hasNativeGit', 12)
      .symbol(7, 'scip-typescript npm fixture 1.0.0 src/`effect-failure.ts`/assertStable().', 'assertStable', 12)
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
      .definition(6, 6, 6, 0, 0, 2, 1)
      .definition(7, 7, 7, 0, 0, 4, 1)
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

  it('does not flag a zero-input capability predicate that is intentionally constant', () => {
    expect(decorativeCheckers(db).some((finding) => finding.shortName.includes('hasNativeGit'))).toBe(false);
  });

  it('does not flag a checker whose nested Effect call can fail', () => {
    expect(decorativeCheckers(db).some((finding) => finding.shortName.includes('assertStable'))).toBe(false);
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

// External calibration regressions (2026-07-03 integrity-detector
// calibration against Vega_2.0 and Stable_Management): most sampled
// findings on both repos were one of two archetypes, both fixed here.
describe('decorative-checkers — external calibration regressions', () => {
  let tempDir: string;
  let db: ScipDatabase;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-decorative-checkers-calibration-'));
    const projectRoot = join(tempDir, 'project');
    writeFixtureFiles(projectRoot, {
      // Archetype 1: not actually a function at all — a boolean-expression
      // const (matches the null-kind arrow-const fallback heuristic) and a
      // schema-builder value both have neither throw nor return anywhere in
      // their "body" text, so they read as trivially decorative.
      'src/not-a-function.ts': [
        'export const isRender =',
        "  process.env.RENDER === 'true' || Boolean(process.env.RENDER_SERVICE_ID);",
        'export const validateInvitationSchema = z.object({',
        "  token: z.string().min(1, 'Token is required'),",
        '});',
      ],
      // Archetype 2: a concise-arrow (braceless) body has no `return`
      // keyword to find — a genuinely dynamic predicate and an API-client
      // call that just happens to be named like a checker both looked
      // decorative because neither has one.
      'src/concise-arrow.ts': [
        'export const isTimeoutLikeAbortError = (error: unknown): boolean =>',
        '  isAbortError(error) || (error instanceof Error && error.name === "TimeoutError");',
        'export const checkIssueDuplicates = (projectId: string, input: unknown) =>',
        '  apiClient.postData(issuesClientPaths.duplicateCheck(projectId), input);',
      ],
    });

    const dbPath = join(tempDir, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/not-a-function.ts')
      .document(2, 'typescript', 'src/concise-arrow.ts')
      .symbol(1, 'scip-typescript npm fixture 1.0.0 src/`not-a-function.ts`/isRender.', 'isRender', null)
      .symbol(
        2,
        'scip-typescript npm fixture 1.0.0 src/`not-a-function.ts`/validateInvitationSchema.',
        'validateInvitationSchema',
        null,
      )
      .symbol(
        3,
        'scip-typescript npm fixture 1.0.0 src/`concise-arrow.ts`/isTimeoutLikeAbortError.',
        'isTimeoutLikeAbortError',
        null,
      )
      .symbol(
        4,
        'scip-typescript npm fixture 1.0.0 src/`concise-arrow.ts`/checkIssueDuplicates.',
        'checkIssueDuplicates',
        null,
      )
      .definition(1, 1, 1, 0, 0, 1, 60)
      .definition(2, 1, 2, 2, 0, 4, 3)
      .definition(3, 2, 3, 0, 0, 1, 60)
      .definition(4, 2, 4, 2, 0, 3, 60)
      .write();

    db = new ScipDatabase({ dbPath, projectRoot, indexPath: join(tempDir, 'index.scip') });
  });

  afterAll(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not flag a boolean-expression const with no function shape', () => {
    const findings = decorativeCheckers(db);
    expect(findings.some((f) => f.shortName.includes('isRender'))).toBe(false);
  });

  it('does not flag a schema-builder value with no function shape', () => {
    const findings = decorativeCheckers(db);
    expect(findings.some((f) => f.shortName.includes('validateInvitationSchema'))).toBe(false);
  });

  it('does not flag a concise-arrow predicate with a dynamic implicit return', () => {
    const findings = decorativeCheckers(db);
    expect(findings.some((f) => f.shortName.includes('isTimeoutLikeAbortError'))).toBe(false);
  });

  it('does not flag a concise-arrow API-client call named like a checker', () => {
    const findings = decorativeCheckers(db);
    expect(findings.some((f) => f.shortName.includes('checkIssueDuplicates'))).toBe(false);
  });
});

// External calibration: once the archetypes above were fixed, this was the
// single dominant remaining false-positive shape on BOTH external repos (and
// this repo's own src/runtime/config.ts / src/tla/conformance.ts) — a
// validator reporting failure via a diagnostic-sink call (Zod's
// `ctx.addIssue(...)`, or pushing onto a caller-supplied errors array)
// instead of throw/return false/an error-result literal.
describe('decorative-checkers — diagnostic-sink failure signal (ctx.addIssue / errors.push)', () => {
  let tempDir: string;
  let db: ScipDatabase;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-decorative-checkers-diagnostic-sink-'));
    const projectRoot = join(tempDir, 'project');
    writeFixtureFiles(projectRoot, {
      'src/zod-refinement.ts': [
        'const validateSlotWindow = (payload: { startTime?: string }, ctx: z.RefinementCtx) => {',
        '  if (!payload.startTime) {',
        "    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'startTime is required' });",
        '  }',
        '};',
      ],
      'src/errors-array.ts': [
        'function validateDocsConfig(config: ProjectConfig, diagnostics: ConfigDiagnostic[]): void {',
        '  if (!Array.isArray(config.docs?.snapshotPaths)) {',
        "    diagnostics.push({ level: 'error', message: 'Must be an array.' });",
        '  }',
        '}',
      ],
    });

    const dbPath = join(tempDir, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/zod-refinement.ts')
      .document(2, 'typescript', 'src/errors-array.ts')
      .symbol(
        1,
        'scip-typescript npm fixture 1.0.0 src/`zod-refinement.ts`/validateSlotWindow.',
        'validateSlotWindow',
        null,
      )
      .symbol(
        2,
        'scip-typescript npm fixture 1.0.0 src/`errors-array.ts`/validateDocsConfig().',
        'validateDocsConfig',
        12,
      )
      .definition(1, 1, 1, 0, 0, 4, 1)
      .definition(2, 2, 2, 0, 0, 4, 1)
      .write();

    db = new ScipDatabase({ dbPath, projectRoot, indexPath: join(tempDir, 'index.scip') });
  });

  afterAll(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not flag a Zod RefinementCtx validator that reports failure via ctx.addIssue', () => {
    const findings = decorativeCheckers(db);
    expect(findings.some((f) => f.shortName.includes('validateSlotWindow'))).toBe(false);
  });

  it('does not flag a validator that reports failure by pushing onto an errors array parameter', () => {
    const findings = decorativeCheckers(db);
    expect(findings.some((f) => f.shortName.includes('validateDocsConfig'))).toBe(false);
  });
});
