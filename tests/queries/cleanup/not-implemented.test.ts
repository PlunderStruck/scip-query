import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notImplemented } from '../../../src/queries/cleanup/not-implemented.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

describe('not-implemented', () => {
  let tempDir: string;
  let db: ScipDatabase;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-not-implemented-'));
    const projectRoot = join(tempDir, 'project');
    writeFixtureFiles(projectRoot, {
      // Reachable throw-stub: a real caller elsewhere imports and calls it.
      'src/reachable-stub.ts': [
        'export function reachableStub(): string {',
        "  throw new Error('not implemented');",
        '}',
      ],
      'src/caller.ts': [
        "import { reachableStub } from './reachable-stub.js';",
        'export function useIt(): string {',
        '  return reachableStub();',
        '}',
      ],
      // Same throw-stub shape, but nothing anywhere calls it — dead's job.
      'src/dead-stub.ts': ['export function deadStub(): string {', "  throw new Error('not implemented');", '}'],
      // Abstract base method thrown, overridden by every concrete subclass —
      // must not fire even though it has a real caller.
      'src/base.ts': [
        'export abstract class Base {',
        '  process(): void {',
        "    throw new Error('not implemented');",
        '  }',
        '}',
      ],
      'src/sub-a.ts': [
        "import { Base } from './base.js';",
        'export class SubA extends Base {',
        '  process(): void {',
        "    console.log('a');",
        '  }',
        '}',
      ],
      'src/sub-b.ts': [
        "import { Base } from './base.js';",
        'export class SubB extends Base {',
        '  process(): void {',
        "    console.log('b');",
        '  }',
        '}',
      ],
      'src/base-caller.ts': [
        "import { Base } from './base.js';",
        'export function run(instance: Base): void {',
        '  instance.process();',
        '}',
      ],
    });

    const dbPath = join(tempDir, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/reachable-stub.ts')
      .document(2, 'typescript', 'src/dead-stub.ts')
      .document(3, 'typescript', 'src/base.ts')
      .document(4, 'typescript', 'src/sub-a.ts')
      .document(5, 'typescript', 'src/sub-b.ts')
      .symbol(1, 'scip-typescript npm fixture 1.0.0 src/`reachable-stub.ts`/reachableStub().', 'reachableStub', 12)
      .symbol(2, 'scip-typescript npm fixture 1.0.0 src/`dead-stub.ts`/deadStub().', 'deadStub', 12)
      .symbol(3, 'scip-typescript npm fixture 1.0.0 src/`base.ts`/Base#process().', 'process', 6)
      .symbol(4, 'scip-typescript npm fixture 1.0.0 src/`sub-a.ts`/SubA#process().', 'process', 6)
      .symbol(5, 'scip-typescript npm fixture 1.0.0 src/`sub-b.ts`/SubB#process().', 'process', 6)
      .definition(1, 1, 1, 0, 0, 2, 1)
      .definition(2, 2, 2, 0, 0, 2, 1)
      .definition(3, 3, 3, 1, 2, 3, 3)
      .definition(4, 4, 4, 2, 2, 4, 3)
      .definition(5, 5, 5, 2, 2, 4, 3)
      .write();

    db = new ScipDatabase({ dbPath, projectRoot, indexPath: join(tempDir, 'index.scip') });
  });

  afterAll(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('flags a reachable throw-stub with real-caller evidence', () => {
    const findings = notImplemented(db, { semantic: false });
    const hit = findings.find((f) => f.shortName.includes('reachableStub'));
    expect(hit).toBeDefined();
    expect(hit?.stubKind).toBe('throw-stub');
    expect(hit?.reachability).toBe('caller');
    expect(hit?.callerFanIn).toBeGreaterThan(0);
  });

  it('does not flag an unreachable throw-stub with no callers anywhere (dead owns it)', () => {
    const findings = notImplemented(db, { semantic: false });
    expect(findings.some((f) => f.shortName.includes('deadStub'))).toBe(false);
  });

  it('does not flag an abstract-method throw overridden by every concrete subclass', () => {
    const findings = notImplemented(db, { semantic: false });
    expect(findings.some((f) => f.file === 'src/base.ts')).toBe(false);
  });
});

describe('not-implemented — todo-return-default and empty-body stubs on an entry surface', () => {
  let tempDir: string;
  let db: ScipDatabase;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-not-implemented-entry-'));
    const projectRoot = join(tempDir, 'project');
    writeFixtureFiles(projectRoot, {
      // Top-level cli.ts is a structural entry surface — reachable by
      // definition (the framework/binary dispatches it), no caller needed.
      'cli.ts': [
        'export function loadConfig(): Record<string, unknown> | null {',
        '  // TODO: implement config loading',
        '  return null;',
        '}',
        'export function shutdown(): void {',
        '}',
      ],
    });

    const dbPath = join(tempDir, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'cli.ts')
      .symbol(1, 'scip-typescript npm fixture 1.0.0 cli.ts/loadConfig().', 'loadConfig', 12)
      .symbol(2, 'scip-typescript npm fixture 1.0.0 cli.ts/shutdown().', 'shutdown', 12)
      .definition(1, 1, 1, 0, 0, 3, 1)
      .definition(2, 1, 2, 4, 0, 5, 1)
      .write();

    db = new ScipDatabase({ dbPath, projectRoot, indexPath: join(tempDir, 'index.scip') });
  });

  afterAll(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('flags a `// TODO` + return-default body as reachable via the entry surface', () => {
    const findings = notImplemented(db, { semantic: false });
    const hit = findings.find((f) => f.shortName.includes('loadConfig'));
    expect(hit).toBeDefined();
    expect(hit?.stubKind).toBe('todo-return-default');
    expect(hit?.reachability).toBe('entry-surface');
  });

  it('flags an empty body on an exported callable as reachable via the entry surface', () => {
    const findings = notImplemented(db, { semantic: false });
    const hit = findings.find((f) => f.shortName.includes('shutdown'));
    expect(hit).toBeDefined();
    expect(hit?.stubKind).toBe('empty-body');
    expect(hit?.reachability).toBe('entry-surface');
  });
});

// Dogfood regression (found running this detector against this repo's own
// index): a file-level const array assigned from a multi-line `.map((id) =>`
// call chain is classified function-like by the null-kind fallback heuristic
// (matches every other arrow-const detector in this codebase), and when the
// indexer's definition range only spans the first line, the snippet is cut
// off right after the arrow. extractImplementationBody's arrow fallback then
// yields an empty string — indistinguishable from a real empty body unless
// the classifier checks for an actual brace pair first.
describe('not-implemented — arrow-fallback truncated snippet is not an empty-body finding', () => {
  let tempDir: string;
  let db: ScipDatabase;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-not-implemented-truncated-'));
    const projectRoot = join(tempDir, 'project');
    // main.ts is a structural entry surface (reachable by definition), so
    // this fixture isolates the brace-pair guard from reachability — without
    // the guard, this would fire as an 'empty-body' finding purely from the
    // arrow-fallback text-extraction bug, not from any real caller evidence.
    writeFixtureFiles(projectRoot, {
      'main.ts': ['export const orderedThings: string[] = thingsList.map((id) =>', '  resolveThing(id),', ');'],
    });

    const dbPath = join(tempDir, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'main.ts')
      // File-level term (no `#owner`, doesn't end in `().`) — the exact
      // shape isFunctionLikeSymbol's null-kind fallback treats as callable.
      .symbol(1, 'scip-typescript npm fixture 1.0.0 main.ts/orderedThings.', 'orderedThings', null)
      // Definition range covers only the first line, matching the real
      // indexer behavior that produced the false positive.
      .definition(1, 1, 1, 0, 0, 0, 60)
      .write();

    db = new ScipDatabase({ dbPath, projectRoot, indexPath: join(tempDir, 'index.scip') });
  });

  afterAll(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not report the truncated snippet as an empty-body stub', () => {
    const findings = notImplemented(db, { semantic: false });
    expect(findings.some((f) => f.file === 'main.ts')).toBe(false);
  });
});
