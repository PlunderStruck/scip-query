import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testQuality } from '../../../src/queries/cleanup/test-quality.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

// test-quality works entirely off source text + classifyFile — no SCIP
// evidence is needed, so the fixture DB is an empty schema (no documents,
// symbols, or definitions) backing a real project root on disk.
function emptyFixtureDb(projectRoot: string, dbPath: string): ScipDatabase {
  evidenceFixtureDb(dbPath).write();
  return new ScipDatabase({ dbPath, projectRoot, indexPath: join(projectRoot, '..', 'index.scip') });
}

describe('test-quality — assertion-free', () => {
  let tempDir: string;
  let db: ScipDatabase;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-test-quality-assertion-free-'));
    const projectRoot = join(tempDir, 'project');
    writeFixtureFiles(projectRoot, {
      'tests/mock-only.test.ts': [
        "import { it, vi, expect as verify } from 'vitest';",
        "import * as runner from 'vitest';",
        "it('only configures a mock', () => { vi.fn(); });",
        "it('only configures a namespace mock', () => { runner.vi.fn(); });",
        "it('uses an aliased assertion', () => { verify(2).toBe(2); });",
        "it('uses a namespace assertion', () => { runner.expect(2).toBe(2); });",
      ],
      'tests/declaration.test.ts': [
        'declare function test(name: string, run: () => void): void;',
        "test('actual weak callback', () => { const value = 1 + 2; });",
      ],
      'tests/sample.test.ts': [
        "import { describe, expect, it } from 'vitest';",
        '',
        "describe('sample', () => {",
        "  it('does nothing useful', () => {",
        '    doSomething();',
        '  });',
        '',
        "  it('has a real assertion', () => {",
        '    expect(doSomething()).toBe(1);',
        '  });',
        '',
        "  it('awaits only, no assertion', async () => {",
        '    await doSomethingAsync();',
        '  });',
        '});',
      ],
      'tests/async-query.test.ts': [
        "import { it } from 'vitest';",
        '',
        "it('uses an awaited Testing Library query', async () => {",
        "  await screen.findByText('ready');",
        '});',
        '',
        "it('uses a condition-specific wait helper', async () => {",
        "  await waitForText(chunks, 'ping');",
        '});',
      ],
    });
    const dbPath = join(tempDir, 'index.db');
    db = emptyFixtureDb(projectRoot, dbPath);
  });

  afterAll(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not count a test function declaration as an invocation', () => {
    const findings = testQuality(db).assertionFree.filter((finding) => finding.file === 'tests/declaration.test.ts');
    expect(findings).toMatchObject([{ startLine: 1, title: 'actual weak callback' }]);
    expect(findings).toHaveLength(1);
  });

  it('distinguishes runner mock utilities from assertion exports', () => {
    const titles = testQuality(db).assertionFree.map((finding) => finding.title);
    expect(titles).toContain('only configures a mock');
    expect(titles).toContain('only configures a namespace mock');
    expect(titles).not.toContain('uses an aliased assertion');
    expect(titles).not.toContain('uses a namespace assertion');
  });

  it('flags an it block with no assertion call at high severity', () => {
    const report = testQuality(db);
    const hit = report.assertionFree.find((f) => f.title === 'does nothing useful');
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe('high');
  });

  it('does not flag an it block with a real assertion', () => {
    const report = testQuality(db);
    expect(report.assertionFree.some((f) => f.title === 'has a real assertion')).toBe(false);
  });

  it('flags an await-only smoke test at low severity, not skipped', () => {
    const report = testQuality(db);
    const hit = report.assertionFree.find((f) => f.title === 'awaits only, no assertion');
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe('low');
  });

  it('recognizes awaited findBy and condition-specific wait helpers as assertions', () => {
    const titles = testQuality(db).assertionFree.map((finding) => finding.title);
    expect(titles).not.toContain('uses an awaited Testing Library query');
    expect(titles).not.toContain('uses a condition-specific wait helper');
  });
});

// External calibration regression (2026-07-03, against Vega_2.0): a
// RegExp/string `.test(...)` METHOD call (`/pattern/i.test(sql)`) was
// matched as if it were a vitest `test(...)` BLOCK declaration, fabricating
// a bogus block whose "body" was just the call's own argument — reported as
// assertion-free with an "(anonymous)" title, drowning out real findings and
// hiding the real `it(...)` block's genuine assertions (which sit right next
// to the `.test(` calls in the same body and were never even inspected,
// since the fake block hijacked the scan).
describe('test-quality — regexp/string .test(...) method calls are not test blocks', () => {
  let tempDir: string;
  let db: ScipDatabase;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-test-quality-dot-test-'));
    const projectRoot = join(tempDir, 'project');
    writeFixtureFiles(projectRoot, {
      'tests/regex-assertions.test.ts': [
        "import { describe, expect, it } from 'vitest';",
        '',
        "describe('migration guardrails', () => {",
        "  it('keeps RLS migrations present', () => {",
        '    const migrations = [readFile()];',
        '    expect(migrations.some((sql) => /enable row level security/i.test(sql))).toBe(true);',
        '    expect(migrations.some((sql) => /create policy/i.test(sql))).toBe(true);',
        '  });',
        '});',
      ],
    });

    const dbPath = join(tempDir, 'index.db');
    db = emptyFixtureDb(projectRoot, dbPath);
  });

  afterAll(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not fabricate an assertion-free block from a .test( method call', () => {
    const report = testQuality(db);
    expect(report.assertionFree.some((f) => f.title === '(anonymous)')).toBe(false);
  });

  it('still correctly resolves the real it block as having a real assertion', () => {
    const report = testQuality(db);
    expect(report.assertionFree.some((f) => f.title === 'keeps RLS migrations present')).toBe(false);
  });
});

// External calibration regressions (2026-07-03, against Vega_2.0): two more
// real assertion mechanisms the vocabulary-only check couldn't see.
describe('test-quality — throw-based assertions and generic-typed vocabulary calls', () => {
  let tempDir: string;
  let db: ScipDatabase;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-test-quality-throw-generic-'));
    const projectRoot = join(tempDir, 'project');
    writeFixtureFiles(projectRoot, {
      'tests/coverage-sweep.test.ts': [
        "import { describe, it } from 'vitest';",
        '',
        "it('every endpoint returns a consumer-safe value', () => {",
        '  const failures: string[] = [];',
        '  for (const endpoint of endpoints) {',
        '    if (!isSafe(endpoint)) failures.push(endpoint.url);',
        '  }',
        '  if (failures.length > 0) {',
        "    throw new Error(failures.join(', '));",
        '  }',
        '});',
      ],
      'tests/type-assertion.test.ts': [
        "import { expectTypeOf, it } from 'vitest';",
        '',
        "it('keeps API type aliases assignable to shared contract types', () => {",
        '  expectTypeOf<LocalType>().toEqualTypeOf<SharedType>();',
        '});',
      ],
    });
    const dbPath = join(tempDir, 'index.db');
    db = emptyFixtureDb(projectRoot, dbPath);
  });

  afterAll(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not flag a test that collects failures and throws a descriptive error', () => {
    const report = testQuality(db);
    expect(report.assertionFree.some((f) => f.title === 'every endpoint returns a consumer-safe value')).toBe(false);
  });

  it('does not flag a vitest expectTypeOf<T>() call with a generic type argument', () => {
    const report = testQuality(db);
    expect(
      report.assertionFree.some((f) => f.title === 'keeps API type aliases assignable to shared contract types'),
    ).toBe(false);
  });
});

// Dogfood regression: a test whose only assertion lives inside a local
// helper function (`expectValidTypeScript(x)`, wrapping a real
// `expect(...).toEqual(...)`) looked assertion-free before the one-hop,
// same-file helper resolution — found in this repo's own
// tests/tla/instrument.test.ts.
describe('test-quality — assertion inside a local same-file helper', () => {
  let tempDir: string;
  let db: ScipDatabase;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-test-quality-local-helper-'));
    const projectRoot = join(tempDir, 'project');
    writeFixtureFiles(projectRoot, {
      'tests/helper-delegated.test.ts': [
        "import { expect, it } from 'vitest';",
        '',
        'function expectValidThing(value: unknown): void {',
        '  const messages = validate(value);',
        '  expect(messages).toEqual([]);',
        '}',
        '',
        "it('delegates its assertion to a local helper', () => {",
        '  expectValidThing(buildThing());',
        '});',
      ],
    });
    const dbPath = join(tempDir, 'index.db');
    db = emptyFixtureDb(projectRoot, dbPath);
  });

  afterAll(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not flag a test whose local helper performs the real assertion', () => {
    const report = testQuality(db);
    expect(report.assertionFree.some((f) => f.title === 'delegates its assertion to a local helper')).toBe(false);
  });
});

// Dogfood regression (found running this detector against this repo's own
// test suite, before it ever shipped): a single-quoted test title containing
// a backtick (an extremely common "code span in a title" shape, e.g. a title
// quoting `@/*`) made the old sequential-regex string masker treat that
// interior backtick as opening a template literal, then swallow everything
// up to the NEXT unrelated backtick anywhere later in the file — masking a
// real assertion right out of existence and making a fully-tested `it` block
// look assertion-free.
describe('test-quality — backtick inside a single-quoted title does not corrupt masking', () => {
  let tempDir: string;
  let db: ScipDatabase;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-test-quality-backtick-title-'));
    const projectRoot = join(tempDir, 'project');
    writeFixtureFiles(projectRoot, {
      'tests/backtick-title.test.ts': [
        "import { expect, it } from 'vitest';",
        '',
        "it('resolves a `@/*` alias declared directly in config', () => {",
        '  const resolved = resolveThing();',
        "  expect(resolved).toBe('ok');",
        '});',
        '',
        "it('a later, unrelated test with its own `backtick` span', () => {",
        '  doSomethingUnrelated();',
        '});',
      ],
    });
    const dbPath = join(tempDir, 'index.db');
    db = emptyFixtureDb(projectRoot, dbPath);
  });

  afterAll(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not flag the assertion-bearing test as assertion-free', () => {
    const report = testQuality(db);
    expect(report.assertionFree.some((f) => f.title.startsWith('resolves a `@/*`'))).toBe(false);
  });

  it('still flags the genuinely assertion-free later test', () => {
    const report = testQuality(db);
    expect(report.assertionFree.some((f) => f.title.startsWith('a later, unrelated test'))).toBe(true);
  });
});

describe('test-quality — mock-echo', () => {
  let tempDir: string;
  let db: ScipDatabase;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-test-quality-mock-echo-'));
    const projectRoot = join(tempDir, 'project');
    writeFixtureFiles(projectRoot, {
      'tests/mocking.test.ts': [
        "import { expect, it, vi } from 'vitest';",
        '',
        "it('echoes the stub back at itself', () => {",
        '  const fetcher = vi.fn();',
        '  fetcher.mockReturnValue(42);',
        '  expect(fetcher()).toBe(42);',
        '});',
        '',
        "it('asserts a different value than the stub', () => {",
        '  const fetcher = vi.fn();',
        '  fetcher.mockReturnValue(1);',
        '  const result = fetcher() + 1;',
        '  expect(result).toBe(2);',
        '});',
        '',
        // Dogfood regression: a mock stubbed with a generic boolean literal
        // and an UNRELATED assertion later in the same test that happens to
        // also assert `true` is not a real echo — found in this repo's own
        // reindex-reliability.test.ts (mockReturnValue(true) on process.kill,
        // unrelated expect(existsSync(...)).toBe(true) afterward).
        "it('coincidentally shares a generic boolean literal, not a real echo', () => {",
        "  const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);",
        '  doUnrelatedWork();',
        '  expect(somethingElseEntirely()).toBe(true);',
        '  killSpy.mockRestore();',
        '});',
      ],
    });
    const dbPath = join(tempDir, 'index.db');
    db = emptyFixtureDb(projectRoot, dbPath);
  });

  afterAll(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('flags a test that asserts the same literal it stubbed into a mock', () => {
    const report = testQuality(db);
    const hit = report.mockEcho.find((f) => f.title === 'echoes the stub back at itself');
    expect(hit).toBeDefined();
    expect(hit?.echoedValue).toBe('42');
  });

  it('does not flag a test asserting a different value than the mock stub', () => {
    const report = testQuality(db);
    expect(report.mockEcho.some((f) => f.title === 'asserts a different value than the stub')).toBe(false);
  });

  it('does not flag a coincidental shared generic boolean literal as a mock-echo', () => {
    const report = testQuality(db);
    expect(
      report.mockEcho.some((f) => f.title === 'coincidentally shares a generic boolean literal, not a real echo'),
    ).toBe(false);
  });
});

describe('test-quality — skipped ledger', () => {
  let tempDir: string;
  let db: ScipDatabase;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-test-quality-skipped-'));
    const projectRoot = join(tempDir, 'project');
    writeFixtureFiles(projectRoot, {
      'tests/skips.test.ts': [
        "import { describe, it } from 'vitest';",
        '',
        "it.skip('an old skip', () => {});",
        "xit('another skipped test', () => {});",
        '',
        "describe.skip('a fresh skip', () => {",
        "  it('inner', () => {});",
        '});',
      ],
    });

    // A real git repo so git-blame age classification (rot vs workflow) is
    // exercised end to end: the first two skip lines committed 100 days
    // ago (rot), the describe.skip block added just now (workflow).
    const git = (args: string[], env?: Record<string, string>): void => {
      execFileSync('git', args, { cwd: projectRoot, stdio: 'ignore', env: { ...process.env, ...env } });
    };
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    writeFixtureFiles(projectRoot, {
      'tests/skips.test.ts': [
        "import { describe, it } from 'vitest';",
        '',
        "it.skip('an old skip', () => {});",
        "xit('another skipped test', () => {});",
      ],
    });
    git(['add', 'tests/skips.test.ts']);
    git(['commit', '-q', '-m', 'old skips'], { GIT_AUTHOR_DATE: oldDate, GIT_COMMITTER_DATE: oldDate });

    writeFixtureFiles(projectRoot, {
      'tests/skips.test.ts': [
        "import { describe, it } from 'vitest';",
        '',
        "it.skip('an old skip', () => {});",
        "xit('another skipped test', () => {});",
        '',
        "describe.skip('a fresh skip', () => {",
        "  it('inner', () => {});",
        '});',
      ],
    });
    git(['add', 'tests/skips.test.ts']);
    git(['commit', '-q', '-m', 'add fresh skip']);

    const dbPath = join(tempDir, 'index.db');
    db = emptyFixtureDb(projectRoot, dbPath);
  });

  afterAll(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('inventories it.skip, xit, and describe.skip with title and block kind', () => {
    const report = testQuality(db);
    const titles = report.skipped.map((f) => f.title);
    expect(titles).toContain('an old skip');
    expect(titles).toContain('another skipped test');
    expect(titles).toContain('a fresh skip');

    const describeSkip = report.skipped.find((f) => f.title === 'a fresh skip');
    expect(describeSkip?.blockKind).toBe('describe');
  });

  it('classifies an old skip as rot and a fresh skip as workflow via git-blame age', () => {
    const report = testQuality(db, { rotDays: 60 });
    const oldSkip = report.skipped.find((f) => f.title === 'an old skip');
    const freshSkip = report.skipped.find((f) => f.title === 'a fresh skip');
    expect(oldSkip?.rot).toBe('rot');
    expect(freshSkip?.rot).toBe('workflow');
  });
});
