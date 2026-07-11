import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ts from 'typescript';
import { SymbolInformation_Kind } from '@c4312/scip';
import { ScipDatabase } from '../../../src/storage/db.js';
import { twinAb, defaultTwinAbOutPath } from '../../../src/queries/cleanup/twin-ab.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

describe('twin-ab', () => {
  let tempDir: string;
  let db: ScipDatabase;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-twin-ab-'));
    const projectRoot = join(tempDir, 'project');
    writeFixtureFiles(projectRoot, {
      'src/regex-a.ts': [
        'export function escapeRegex(value: string): string {',
        "  return value.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');",
        '}',
      ],
      'src/regex-b.ts': [
        'export function escapeRegExp(value: string): string {',
        "  return value.replace(/[.*+?^${}()\\\\]/g, '\\\\-');",
        '}',
      ],
      'src/three-args.ts': [
        'export function threeArgs(a: string, b: number, c: boolean): string {',
        '  return `${a}${b}${c}`;',
        '}',
      ],
      'src/not-exported.ts': [
        "export const runtime = 'nodejs';",
        '',
        'function secretHelper(value: string): string {',
        '  return value;',
        '}',
      ],
      'src/not-callable.ts': ['export const notCallable: number = 1;'],
    });

    const dbPath = join(tempDir, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/regex-a.ts')
      .document(2, 'typescript', 'src/regex-b.ts')
      .document(3, 'typescript', 'src/three-args.ts')
      .document(4, 'typescript', 'src/not-exported.ts')
      .document(5, 'typescript', 'src/not-callable.ts')
      .symbol(
        1,
        'scip-typescript npm fixture 1.0.0 src/`regex-a.ts`/escapeRegex().',
        'escapeRegex',
        SymbolInformation_Kind.Function,
        '```ts\n(value: string): string\n```',
      )
      .symbol(
        2,
        'scip-typescript npm fixture 1.0.0 src/`regex-b.ts`/escapeRegExp().',
        'escapeRegExp',
        SymbolInformation_Kind.Function,
        '```ts\n(value: string): string\n```',
      )
      .symbol(
        3,
        'scip-typescript npm fixture 1.0.0 src/`three-args.ts`/threeArgs().',
        'threeArgs',
        SymbolInformation_Kind.Function,
        '```ts\n(a: string, b: number, c: boolean): string\n```',
      )
      .symbol(
        4,
        'scip-typescript npm fixture 1.0.0 src/`not-exported.ts`/secretHelper().',
        'secretHelper',
        SymbolInformation_Kind.Function,
        '```ts\n(value: string): string\n```',
      )
      .symbol(
        5,
        'scip-typescript npm fixture 1.0.0 src/`not-callable.ts`/notCallable.',
        'notCallable',
        SymbolInformation_Kind.Constant,
      )
      .definition(1, 1, 1, 0, 0, 2, 1)
      .definition(2, 2, 2, 0, 0, 2, 1)
      .definition(3, 3, 3, 0, 0, 2, 1)
      .definition(4, 4, 4, 2, 0, 4, 1)
      .definition(5, 5, 5, 0, 0, 0, 30)
      .write();

    db = new ScipDatabase({ dbPath, projectRoot, indexPath: join(tempDir, 'index.scip') });
  });

  afterAll(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves a real exported twin pair with matching signatures and generates an importable scaffold', () => {
    const outFile = join(db.config.projectRoot, defaultTwinAbOutPath('escapeRegex', 'escapeRegExp'));
    const outcome = twinAb(db, 'escapeRegex', 'escapeRegExp', outFile);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.a.shortName).toBe('escapeRegex');
    expect(outcome.b.shortName).toBe('escapeRegExp');
    expect(outcome.a.paramCount).toBe(1);
    expect(outcome.b.paramCount).toBe(1);
    expect(outcome.signatureCompatible).toBe(true);
    expect(outcome.testSource).toContain("import { describe, expect, it } from 'vitest';");
    expect(outcome.testSource).toContain('escapeRegex as twinA');
    expect(outcome.testSource).toContain('escapeRegExp as twinB');
    expect(outcome.testSource).toContain('drill 5');
    expect(outcome.testSource).toContain('TODO');
  });

  it('flags a mismatched param count as signature-incompatible but still generates a scaffold', () => {
    const outFile = join(db.config.projectRoot, defaultTwinAbOutPath('escapeRegex', 'threeArgs'));
    const outcome = twinAb(db, 'escapeRegex', 'threeArgs', outFile);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.a.paramCount).toBe(1);
    expect(outcome.b.paramCount).toBe(3);
    expect(outcome.signatureCompatible).toBe(false);
    expect(outcome.testSource).toContain('DIFFER');
  });

  it('refuses a symbol that does not resolve', () => {
    const outFile = join(db.config.projectRoot, defaultTwinAbOutPath('escapeRegex', 'doesNotExist'));
    const outcome = twinAb(db, 'escapeRegex', 'doesNotExist', outFile);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain('does not resolve');
  });

  it('refuses a non-callable symbol with an actionable message', () => {
    const outFile = join(db.config.projectRoot, defaultTwinAbOutPath('escapeRegex', 'notCallable'));
    const outcome = twinAb(db, 'escapeRegex', 'notCallable', outFile);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain('notCallable');
    expect(outcome.reason).toContain('must be functions or methods');
  });

  it('refuses a private symbol even when a nearby declaration is exported', () => {
    const outFile = join(db.config.projectRoot, defaultTwinAbOutPath('escapeRegex', 'secretHelper'));
    const outcome = twinAb(db, 'escapeRegex', 'secretHelper', outFile);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain('secretHelper');
    expect(outcome.reason).toContain('not exported');
  });

  it('generates a scaffold that actually type-checks against the real twin signatures', () => {
    const outFile = join(db.config.projectRoot, defaultTwinAbOutPath('escapeRegex', 'escapeRegExp'));
    const outcome = twinAb(db, 'escapeRegex', 'escapeRegExp', outFile);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, outcome.testSource);

    // Ambient ('vitest' has no real package here) module declaration so the
    // compile check validates the generated file's own correctness — real
    // relative import paths resolving to the real twin signatures, correct
    // call arity — without depending on vitest's actual types being
    // resolvable from a throwaway fixture directory.
    const vitestStubPath = join(tempDir, 'vitest-stub.d.ts');
    writeFileSync(
      vitestStubPath,
      [
        "declare module 'vitest' {",
        '  export const describe: { (name: string, fn: () => void): void; skipIf(condition: boolean): typeof describe };',
        '  export const it: { each(cases: readonly unknown[][]): (name: string, fn: (...args: any[]) => void) => void };',
        '  export function expect(actual: unknown): { toEqual(expected: unknown): void };',
        '}',
      ].join('\n'),
    );

    const program = ts.createProgram([outFile, vitestStubPath], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      noEmit: true,
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    const messages = diagnostics.map(
      (d) => `${d.file?.fileName ?? ''}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`,
    );
    expect(messages).toEqual([]);
  });
});

/**
 * Regression coverage for a real bug found while validating this command
 * against this project's own live index: scip-typescript never populates
 * `global_symbols.kind` here (confirmed directly against the real index.db
 * — every one of 16,370 rows has a null kind), so a callability check gated
 * on `kind` alone refuses every real symbol. These fixtures deliberately
 * omit `kind` (the `evidenceFixtureDb.symbol()` default is null) to mirror
 * the real indexer and lock in the symbol-string-shape fallback.
 */
describe('twin-ab — null SCIP kind (matches the real scip-typescript index)', () => {
  let tempDir: string;
  let db: ScipDatabase;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-twin-ab-null-kind-'));
    const projectRoot = join(tempDir, 'project');
    writeFixtureFiles(projectRoot, {
      'src/a.ts': ['export function escapeRegex(value: string) {', '  return value;', '}'],
      'src/b.ts': ['export function escapeRegExp(value: string) {', '  return value;', '}'],
      'src/c.ts': ['export interface NotCallable {', '  value: string;', '}'],
    });

    const dbPath = join(tempDir, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/a.ts')
      .document(2, 'typescript', 'src/b.ts')
      .document(3, 'typescript', 'src/c.ts')
      // No `kind` argument — defaults to null, matching every row of this
      // project's real index.
      .symbol(1, 'scip-typescript npm fixture 1.0.0 src/`a.ts`/escapeRegex().', 'escapeRegex')
      .symbol(2, 'scip-typescript npm fixture 1.0.0 src/`b.ts`/escapeRegExp().', 'escapeRegExp')
      .symbol(3, 'scip-typescript npm fixture 1.0.0 src/`c.ts`/NotCallable#', 'NotCallable')
      .definition(1, 1, 1, 0, 0, 2, 1)
      .definition(2, 2, 2, 0, 0, 2, 1)
      .definition(3, 3, 3, 0, 0, 2, 1)
      .write();

    db = new ScipDatabase({ dbPath, projectRoot, indexPath: join(tempDir, 'index.scip') });
  });

  afterAll(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('still resolves a real exported twin pair when the index leaves kind null', () => {
    const outFile = join(db.config.projectRoot, defaultTwinAbOutPath('escapeRegex', 'escapeRegExp'));
    const outcome = twinAb(db, 'escapeRegex', 'escapeRegExp', outFile);

    expect(outcome.ok).toBe(true);
  });

  it('still refuses a non-callable symbol (SCIP-generated `#` member descriptor) even with a null kind', () => {
    const outFile = join(db.config.projectRoot, defaultTwinAbOutPath('escapeRegex', 'NotCallable'));
    const outcome = twinAb(db, 'escapeRegex', 'NotCallable', outFile);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain('must be functions or methods');
  });
});
