import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sourceMaintenanceReport } from '../../../src/queries/health/source-review.js';
import { analyzeSourceFunctions, sourceHash } from '../../../src/source/ast/function-metrics.js';
import { functionCoverage } from '../../../src/source/maintenance-coverage.js';
import { buildAutomatedSuppressionDecision, writeSuppressionFile } from '../../../src/runtime/suppression-writer.js';
import { readSuppressionDir } from '../../../src/storage/suppression-store.js';

const roots: string[] = [];
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'scip-source-review-'));
  roots.push(root);
  write(root, files);
  git(root, ['init', '-q']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base']);
  return root;
}
function write(root: string, files: Record<string, string>): void {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
}
function git(root: string, args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'pipe' });
}
const body = `const selected = values.filter(value => value.active);
  const total = selected.reduce((sum, value) => sum + value.amount, 0);
  if (total > 100) return { total, tier: 'large', count: selected.length };
  return { total, tier: 'small', count: selected.length };`;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('source health and diff review', () => {
  it('keeps a finding open when counterevidence does not bind its target bytes', () => {
    const source = `export function run(x) { ${'if (x) {'.repeat(6)} return x; ${'}'.repeat(6)} return 0; }`;
    const root = project({ 'src/code.ts': source, 'fixture.json': '{"purpose":"parser fixture"}' });
    const finding = sourceMaintenanceReport(root).findings.find((entry) => entry.rule === 'complexity')!;
    writeSuppressionFile(root, {
      id: finding.id,
      reason: 'Parser fixture declared by configuration',
      decision: buildAutomatedSuppressionDecision(root, 'test-fixture', ['config:fixture.json'], 'Parser fixture'),
    });
    for (const target of [source, source + '\n// target changed while counterevidence stayed fixed']) {
      write(root, { 'src/code.ts': target });
      const report = sourceMaintenanceReport(root);
      expect(report.suppressionDecisions).toMatchObject([{ id: finding.id, outcome: 'escalated' }]);
      expect(report.blockingFindingIds).toContain(finding.id);
    }
  });

  it('adjudicates a source exception without an index, retains raw findings, and invalidates changed evidence', () => {
    const source = `export function run(x) { ${'if (x) {'.repeat(6)} return x; ${'}'.repeat(6)} return 0; }`;
    const root = project({ 'src/code.ts': source });
    const original = sourceMaintenanceReport(root);
    const finding = original.findings.find((entry) => entry.rule === 'complexity')!;
    expect(original.blockingFindingIds).toContain(finding.id);
    writeSuppressionFile(root, {
      id: finding.id,
      reason: 'Deliberate nested fixture for exercising a parser',
      decision: buildAutomatedSuppressionDecision(
        root,
        'test-fixture',
        ['source:src/code.ts'],
        'Deliberate nested fixture',
      ),
    });
    const accepted = sourceMaintenanceReport(root);
    expect(accepted.suppressionDecisions).toMatchObject([{ id: finding.id, outcome: 'accepted' }]);
    expect(accepted.findings).toContainEqual(finding);
    expect(accepted.blockingFindingIds).not.toContain(finding.id);
    write(root, { 'src/code.ts': source + '\n// Changed target bytes\n' });
    const changed = sourceMaintenanceReport(root);
    expect(changed.suppressionDecisions).toMatchObject([{ id: finding.id, outcome: 'invalidated' }]);
    expect(changed.blockingFindingIds).toContain(finding.id);
  });

  it.each(['expired', 'legacy', 'wrong-scope'])('keeps a finding blocking when its decision is %s', (kind) => {
    const source = `export function run(x) { ${'if (x) {'.repeat(6)} return x; ${'}'.repeat(6)} return 0; }`;
    const root = project({ 'code.ts': source });
    const finding = sourceMaintenanceReport(root).findings.find((entry) => entry.rule === 'complexity')!;
    writeSuppressionFile(root, {
      id: finding.id,
      reason: 'reviewed',
      ...(kind === 'expired' ? { expiresAt: '2000-01-01T00:00:00Z' } : {}),
      ...(kind === 'wrong-scope' ? { check: 'duplication' } : {}),
      ...(kind === 'legacy'
        ? {}
        : { decision: buildAutomatedSuppressionDecision(root, 'test-fixture', ['source:code.ts'], 'fixture') }),
    });
    const report = sourceMaintenanceReport(root);
    expect(report.suppressionDecisions[0]?.outcome).toBe(kind === 'expired' ? 'expired' : 'escalated');
    expect(report.blockingFindingIds).toContain(finding.id);
  });

  it.each([false, true])('handles stored/configured suppression duplicates (conflicting=%s)', (conflicting) => {
    const source = `export function run(x) { ${'if (x) {'.repeat(6)} return x; ${'}'.repeat(6)} return 0; }`;
    const root = project({ 'code.ts': source });
    const finding = sourceMaintenanceReport(root).findings.find((entry) => entry.rule === 'complexity')!;
    writeSuppressionFile(root, {
      id: finding.id,
      reason: 'Deliberate parser fixture',
      decision: buildAutomatedSuppressionDecision(root, 'test-fixture', ['source:code.ts'], 'fixture'),
    });
    const record = readSuppressionDir(root).suppressions[0]!;
    write(root, {
      '.scipquery.json': JSON.stringify({
        suppressions: [{ ...record, ...(conflicting ? { expiresAt: '2000-01-01T00:00:00Z' } : {}) }],
      }),
    });
    const report = sourceMaintenanceReport(root);
    expect(report.suppressionDecisions).toHaveLength(1);
    expect(report.suppressionDecisions[0]?.outcome).toBe(conflicting ? 'escalated' : 'accepted');
    expect(report.blockingFindingIds.includes(finding.id)).toBe(conflicting);
    if (conflicting) expect(report.suppressionDecisions[0]?.reasons.join(' ')).toContain('Conflicting');
  });

  it('flags an increased complexity measure even when the ranking score is unchanged', () => {
    const source = `export function run(x) { ${'if (x) {'.repeat(6)} return x; ${'}'.repeat(6)} return 0; }`;
    const root = project({ 'code.ts': source });
    write(root, { 'code.ts': source.replace('return x;', 'return x ?? 0;') });
    const report = sourceMaintenanceReport(root, { base: 'HEAD' });
    expect(report.functions[0]?.delta).toEqual({ cyclomatic: 1, cognitive: 0 });
    expect(report.findings.find((finding) => finding.rule === 'complexity')).toMatchObject({ status: 'worsened' });
  });

  it('finds added functions in old files and untracked files, including same-file copies', () => {
    const source = `export function existing(values) { ${body} }`;
    const root = project({
      'src/rules.ts': source,
      'src/client.ts': `import { existing } from './rules.js'; export const run = existing;`,
    });
    write(root, {
      'src/rules.ts': source + `\nexport function copied(values) { ${body} }`,
      'src/new file.ts': 'export const added = (x) => x ? 1 : 2;',
    });
    const report = sourceMaintenanceReport(root, { base: 'HEAD' });
    expect(report.coverage.status).toBe('accounted');
    expect(report.changedFiles).toEqual(['src/new file.ts', 'src/rules.ts']);
    expect(report.functions.filter((fn) => fn.status === 'added').map((fn) => fn.after!.name)).toEqual([
      'added',
      'copied',
      'copied.selected.<callback:values.filter:0>',
      'copied.total.<callback:selected.reduce:0>',
    ]);
    expect(report.findings.find((finding) => finding.rule === 'duplication')).toMatchObject({
      status: 'introduced',
      evidence: 'candidate',
      sites: [{ name: 'existing' }, { name: 'copied' }],
    });
    expect(report.affectedFiles).toEqual(['src/client.ts']);
    expect(report.functions.every((fn) => fn.after?.coverage.status === 'unavailable')).toBe(true);
  });

  it('compares actual base and current bytes, avoiding staged changes reverted in the worktree', () => {
    const source = 'export function run(x) { return x; }';
    const root = project({ 'src/code.ts': source });
    write(root, { 'src/code.ts': 'export function run(x) { if(x) return 1; return 0; }' });
    git(root, ['add', '.']);
    write(root, { 'src/code.ts': source });
    const report = sourceMaintenanceReport(root, { base: 'HEAD' });
    expect(report.changedFiles).toEqual([]);
    expect(report.functions).toEqual([]);
  });

  it('reports deleted functions and before/after complexity without assigning zero coverage', () => {
    const root = project({ 'gone.ts': 'function old() { return 1; }', 'code.ts': 'function run(x) { return x; }' });
    rmSync(join(root, 'gone.ts'));
    write(root, { 'code.ts': 'function run(x) { if (x) { if (x > 1) return 2; } return 0; }' });
    const report = sourceMaintenanceReport(root, { base: 'HEAD' });
    expect(report.coverage.problems).toEqual([]);
    expect(report.functions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'removed', before: expect.objectContaining({ name: 'old' }) }),
        expect.objectContaining({ status: 'modified', delta: { cyclomatic: 2, cognitive: 3 } }),
      ]),
    );
  });

  it('works on first adoption without an index and identifies relative import cycles', () => {
    const root = project({
      'a.ts': "import { b } from './b.js'; export function a() { return b(); }",
      'b.ts': "import { a } from './a.js'; export function b() { return a(); }",
    });
    const report = sourceMaintenanceReport(root);
    expect(report.findings.find((finding) => finding.rule === 'dependency-cycle')).toMatchObject({
      evidence: 'derived',
      sites: [
        { file: 'a.ts', line: 1 },
        { file: 'b.ts', line: 1 },
      ],
    });
    expect(report.coverage.status).toBe('accounted');
  });

  it('discloses bounded and broken scans instead of claiming a clean repository', () => {
    const root = project({ 'a.ts': 'function ok() {}', 'b.ts': 'function broken( {' });
    expect(sourceMaintenanceReport(root).coverage.status).toBe('incomplete');
    expect(sourceMaintenanceReport(root, { maxFiles: 1 }).coverage.problems.join()).toContain('omitted');
  });

  it('retains different literals as distinct implementations', () => {
    const root = project({
      'a.ts': `function a(values) { ${body} }\nfunction b(values) { ${body.replaceAll("'large'", "'enormous'")} }`,
    });
    expect(sourceMaintenanceReport(root).findings.filter((finding) => finding.rule === 'duplication')).toEqual([]);
  });

  it('refuses nonexistent Git bases instead of treating everything as new', () => {
    const root = project({ 'a.ts': 'function run() {}' });
    expect(() => sourceMaintenanceReport(root, { base: 'not-a-commit' })).toThrow();
  });

  it('reports consumers left importing a removed file', () => {
    const root = project({
      'owner.ts': 'export const value = 1;',
      'consumer.ts': "import { value } from './owner.js'; export const read = () => value;",
    });
    rmSync(join(root, 'owner.ts'));
    const report = sourceMaintenanceReport(root, { base: 'HEAD' });
    expect(report.affectedFiles).toEqual(['consumer.ts']);
    expect(report.findings.find((finding) => finding.rule === 'broken-dependency')).toMatchObject({
      status: 'introduced',
      sites: [
        { file: 'consumer.ts', line: 1 },
        { file: 'owner.ts', line: 1 },
      ],
    });
  });

  it('does not call a function removed when its current file failed to parse', () => {
    const root = project({ 'a.ts': 'function run() { return 1; }' });
    write(root, { 'a.ts': 'function run( {' });
    const report = sourceMaintenanceReport(root, { base: 'HEAD' });
    expect(report.functions).toEqual([
      expect.objectContaining({ status: 'uncomparable', before: expect.objectContaining({ name: 'run' }) }),
    ]);
  });

  it('reviews forbidden dependencies when only the imported target changes', () => {
    const root = project({ 'a.ts': "import { value } from './b.js'; export const read = () => value;" });
    write(root, { 'b.ts': 'export const value = 1;' });
    const architecture = {
      boundaries: [
        { name: 'a', paths: ['a.ts'] },
        { name: 'b', paths: ['b.ts'] },
      ],
      allowedDependencies: { a: [], b: [] },
    };
    const report = sourceMaintenanceReport(root, { base: 'HEAD', scope: 'b.ts', architecture });
    expect(report.findings.find((finding) => finding.rule === 'architecture')).toMatchObject({
      status: 'introduced',
      sites: expect.arrayContaining([{ file: 'b.ts', line: 1 }]),
    });
  });

  it('makes explicitly supplied but unavailable coverage visible in health', () => {
    const root = project({ 'a.ts': 'function run() { return 1; }' });
    write(root, { 'coverage.json': JSON.stringify({ schemaVersion: 1, files: {} }) });
    const report = sourceMaintenanceReport(root, { coverage: 'coverage.json' });
    expect(report.coverage).toMatchObject({
      status: 'incomplete',
      testCoverage: { requested: true, available: 0, unavailable: 1 },
    });
    expect(report.coverage.problems.join()).toContain('Requested test coverage is incomplete');
  });
});

describe('source-matched coverage', () => {
  it('calculates CRAP only from matching measured execution counts', () => {
    const source = 'function run(x) {\n if (x) return 1;\n return 0;\n}';
    const functions = analyzeSourceFunctions('a.ts', source).functions;
    const coverage = {
      files: {
        'a.ts': {
          sourceHash: sourceHash(source),
          coverage: {
            statementMap: { '0': { start: { line: 2, column: 1 } }, '1': { start: { line: 3, column: 1 } } },
            s: { '0': 1, '1': 0 },
          },
        },
      },
    };
    expect(functionCoverage(functions[0]!, functions, source, coverage)).toMatchObject({
      status: 'available',
      fraction: 0.5,
      crap: 2.5,
    });
    expect(functionCoverage(functions[0]!, functions, source + '\n', coverage)).toMatchObject({
      status: 'unavailable',
    });
    expect(functionCoverage(functions[0]!, functions, source, { files: {} })).toMatchObject({ status: 'unavailable' });
  });
});

describe('first-use project and dependency evidence', () => {
  const aliases = (directory: string) =>
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': [directory + '/*'] } } });

  it('reviews alias configuration changes without inventing changed functions', () => {
    const root = project({
      'tsconfig.json': aliases('old'),
      'old/owner.ts': 'export const owner = 1;',
      'next/owner.ts': 'export const owner = 2;',
      'client.ts': "import { owner } from '@/owner'; export function run() { return owner; }",
      'entry.ts': "import { run } from './client'; export const entry = run;",
    });
    write(root, { 'tsconfig.json': aliases('next') });
    const report = sourceMaintenanceReport(root, { base: 'HEAD' });
    expect(report.changedFiles).toEqual([]);
    expect(report.functions).toEqual([]);
    expect(report.configurationChanges).toEqual(['tsconfig.json']);
    expect(report.relationshipChangedFiles).toEqual(['client.ts']);
    expect(report.affectedFiles).toEqual(['client.ts', 'entry.ts']);
    expect(report.coverage.status).toBe('accounted');
  });

  it('compares each revision against its own architecture policy', () => {
    const architecture = {
      boundaries: [
        { name: 'client', paths: ['client.ts'] },
        { name: 'owner', paths: ['owner.ts'] },
      ],
      allowedDependencies: { client: ['owner'] },
    };
    const root = project({
      '.scipquery.json': JSON.stringify({ architecture }),
      'owner.ts': 'export const owner = 1;',
      'client.ts': "import { owner } from './owner'; export const value = owner;",
    });
    write(root, {
      '.scipquery.json': JSON.stringify({ architecture: { ...architecture, allowedDependencies: { client: [] } } }),
    });
    const report = sourceMaintenanceReport(root, { base: 'HEAD' });
    expect(report.functions).toEqual([]);
    expect(report.findings.find((finding) => finding.rule === 'architecture')?.status).toBe('introduced');
    expect(report.architecture.policyCoverage).toMatchObject({
      declaredRows: 1,
      totalBoundaries: 2,
      missingRows: ['owner'],
    });
  });

  it('retains exact complexity deltas when external compiler configuration is unavailable', () => {
    const root = project({
      'tsconfig.json': '{"extends":"unavailable-config"}',
      'run.ts': 'export function run(x) { return x; }',
    });
    write(root, { 'run.ts': 'export function run(x) { return x ? 1 : 0; }' });
    const report = sourceMaintenanceReport(root, { base: 'HEAD' });
    expect(report.coverage.status).toBe('incomplete');
    expect(report.functions[0]).toMatchObject({ status: 'modified', delta: { cyclomatic: 1, cognitive: 1 } });
  });

  it('separates tests, type imports, and dynamic imports from production file cycles', () => {
    const root = project({
      'a.ts': "import type { B } from './b'; export const a = 1;",
      'b.ts': "import { a } from './a'; export type B = typeof a;",
      'c.ts': "export const run = () => import('./d');",
      'd.ts': "import { run } from './c'; export const d = run;",
      'core.ts': "import { test } from './core.test'; export const core = test;",
      'core.test.ts': "import { core } from './core'; export const test = core;",
    });
    const report = sourceMaintenanceReport(root, { includeTests: true });
    expect(report.findings.filter((finding) => finding.rule === 'dependency-cycle')).toEqual([]);
    expect(report.coverage.dependencies).toMatchObject({ typeOnly: 1, test: 1, deferredOrCommonJs: 1 });
  });

  it('does not turn a cycle between declared groups into a file-cycle claim', () => {
    const root = project({
      'a/one.ts': "import '../b/one';",
      'a/two.ts': 'export {};',
      'b/one.ts': 'export {};',
      'b/two.ts': "import '../a/two';",
    });
    const report = sourceMaintenanceReport(root, {
      architecture: {
        boundaries: [
          { name: 'a', paths: ['a/**'] },
          { name: 'b', paths: ['b/**'] },
        ],
      },
    });
    expect(report.architecture.cycles).toHaveLength(1);
    expect(report.findings.filter((finding) => finding.rule === 'dependency-cycle')).toEqual([]);
  });

  it('excludes copied reference and generated source and documents explicit inclusion', () => {
    const root = project({
      'src/app.ts': 'export function app() {}',
      'agent_docs/snapshot/sdk.ts': 'export function sdk() {}',
      'vendor/copied.ts': 'export function copied() {}',
      'src/generated/api.ts': 'export function api() {}',
      'tests/app.ts': 'export function test() {}',
    });
    const ordinary = sourceMaintenanceReport(root);
    expect(ordinary.coverage).toMatchObject({
      analyzedFiles: 1,
      eligibleFiles: 1,
      exclusions: { reference: 2, generated: 1, test: 1 },
    });
    expect(
      sourceMaintenanceReport(root, { includeReferences: true, includeGenerated: true, includeTests: true }).coverage
        .analyzedFiles,
    ).toBe(5);
  });

  it('separates external imports from missing internal dependencies', () => {
    const root = project({
      'tsconfig.json': aliases('src'),
      'src/code.ts':
        "import React from 'react'; import { x } from '@/missing'; import fs from 'fs'; export const run = () => [React, x, fs];",
    });
    const report = sourceMaintenanceReport(root);
    expect(report.coverage.dependencies.resolutions).toMatchObject({ external: 1, missing: 1, builtin: 1 });
    expect(report.coverage.unresolvedImports).toBe(1);
    expect(report.findings.filter((finding) => finding.rule === 'broken-dependency')).toHaveLength(1);
  });

  it('rejects invalid resource bounds at the API boundary', () => {
    const root = project({ 'src/app.ts': 'export {};' });
    expect(() => sourceMaintenanceReport(root, { maxFiles: NaN })).toThrow('positive safe integer');
    expect(() => sourceMaintenanceReport(root, { maxFileBytes: -1 })).toThrow('positive safe integer');
  });
});

it('retains observed asset targets without treating CSS as missing TypeScript or an executable import', () => {
  const root = project({
    'src/page.ts': "import styles from './page.module.css'; export const page = styles;",
    'src/page.module.css': '.page {}',
    'e2e/support.ts': 'export const load = x => import(x);',
  });
  const report = sourceMaintenanceReport(root);
  expect(report.coverage.status).toBe('accounted');
  expect(report.coverage.exclusions.test).toBe(1);
  expect(report.coverage.dependencies.excluded).toEqual([
    expect.objectContaining({ target: 'src/page.module.css', resolution: 'excluded' }),
  ]);
  expect(report.findings.filter((finding) => finding.rule === 'broken-dependency')).toEqual([]);
});

it('does not label uncertain configuration-dependent findings as introduced', () => {
  const root = project({
    'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
    'src/owner.ts': 'export const owner = 1;',
    'client.ts': "import { owner } from '@/owner'; export const client = owner;",
  });
  write(root, {
    'tsconfig.json': JSON.stringify({
      extends: 'missing-preset',
      compilerOptions: { baseUrl: '.', paths: { '@/*': ['absent/*'] } },
    }),
  });
  const report = sourceMaintenanceReport(root, { base: 'HEAD' });
  expect(report.coverage.status).toBe('incomplete');
  expect(report.findings.find((item) => item.rule === 'broken-dependency')?.status).toBe('uncomparable');
});

it('discloses imports of managed build output without claiming a missing project implementation', () => {
  const root = project({ 'scripts/check.ts': "import { run } from '../dist/index.js'; export const check = run;" });
  const report = sourceMaintenanceReport(root);
  expect(report.coverage.unresolvedImports).toBe(0);
  expect(report.coverage.dependencies.excluded[0]).toMatchObject({
    resolution: 'excluded',
    excludedReason: expect.stringContaining('existence is not established'),
  });
  expect(report.coverage.dependencies.excluded[0]?.target).toBeUndefined();
});

it('keeps component identities compact when many modules share a policy finding', () => {
  const files: Record<string, string> = {};
  const boundaries = Array.from({ length: 80 }, (_, index) => ({
    name: `long-declared-module-name-${index}`,
    paths: [`m${index}/**`],
  }));
  for (let index = 0; index < boundaries.length; index++)
    files[`m${index}/a.ts`] = `import '../m${(index + 1) % boundaries.length}/a';`;
  const report = sourceMaintenanceReport(project(files), { architecture: { boundaries, requireAcyclic: true } });
  const cycle = report.findings.find((finding) => finding.rule === 'architecture');
  expect(cycle?.sites).toHaveLength(80);
  expect(cycle!.id.length).toBeLessThan(100);
  expect(report.architecture.boundaries).toHaveLength(80);
  expect(report.modules).toHaveLength(0);
  expect(JSON.stringify(report).length).toBeLessThan(150_000);
});
