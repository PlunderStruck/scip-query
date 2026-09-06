import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sourceSystemReport } from '../../../src/queries/health/source-system.js';
import { sourceMaintenanceReport } from '../../../src/queries/health/source-review.js';
import { renderSourceSystem, withSourceSystem } from '../../../src/runtime/query-commands/source-system.js';

const roots: string[] = [];
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'scip-source-system-'));
  roots.push(root);
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), source);
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const sources = {
  'src/core/calculate.ts': 'export function calculate(value: number) { return value + 1; }',
  'src/api/run.ts': 'import { calculate } from "../core/calculate"; export const run = () => calculate(1);',
  'src/quiet/clean.ts': 'export const message = "export function fake() {}"; // export const imaginary = 1;',
  'src/public/index.ts':
    'export * from "../core/calculate"; export { calculate as evaluate } from "../core/calculate";',
};

describe('current-source module evidence', () => {
  it('includes clean modules and derives real imports and export declarations without an index', () => {
    const root = project(sources);
    expect(sourceMaintenanceReport(root).modules).toEqual([]);
    const report = sourceSystemReport(root);
    expect(report.coverage).toMatchObject({ status: 'accounted', capturedFiles: 4, eligibleFiles: 4 });
    expect(report.totalModules).toBe(4);
    expect(report.modules.flatMap((group) => group.files).sort()).toEqual(Object.keys(sources).sort());
    expect(report.modules.find((group) => group.id === 'directory:src/quiet')).toMatchObject({
      findingIds: [],
      exports: [{ names: ['message'], syntax: 'VariableStatement' }],
    });
    expect(report.modules.flatMap((group) => group.exports.flatMap((item) => item.names))).not.toContain('fake');
    expect(report.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'directory:src/api',
          to: 'directory:src/core',
          importIds: [expect.any(Number)],
        }),
      ]),
    );
    const apiEdge = report.edges.find((edge) => edge.from === 'directory:src/api');
    expect(apiEdge?.importIds.map((id) => report.imports[id])).toEqual([
      expect.objectContaining({ file: 'src/api/run.ts', target: 'src/core/calculate.ts', syntax: 'import' }),
    ]);
    expect(
      report.modules.find((group) => group.id === 'directory:src/public')?.exports.map((item) => item.names),
    ).toEqual([['*'], ['evaluate']]);
    expect(existsSync(join(root, 'index.db'))).toBe(false);
  });

  it('reports declared names from nested export bindings without exposing keys or defaults as names', () => {
    const report = sourceSystemReport(
      project({
        'src/exports.ts': [
          'const input = { source: 1, nested: { value: 2 }, extra: 3 };',
          'export const { source: renamed = 0, nested: { value }, ...rest } = input;',
          'export const [, second, ...tail] = [1, 2, 3];',
          'export default function execute() { return renamed; }',
        ].join('\n'),
      }),
    );
    expect(report.coverage.status).toBe('accounted');
    expect(report.modules[0]?.exports.map((item) => item.names)).toEqual([
      ['renamed', 'value', 'rest'],
      ['second', 'tail'],
      ['default'],
    ]);
  });

  it('stores each import once while module and edge references retain its exact site', () => {
    const report = sourceSystemReport(project(sources));
    expect(report.imports).toHaveLength(3);
    // Two distinct re-export declarations share a line; neither observation may be collapsed.
    expect(report.imports.filter((item) => item.file === 'src/public/index.ts')).toHaveLength(2);
    const outgoing = report.modules.flatMap((group) => group.importIds).sort();
    const incoming = report.modules.flatMap((group) => group.incomingImportIds).sort();
    const edgeSites = report.edges.flatMap((edge) => edge.importIds).sort();
    expect(outgoing).toEqual([0, 1, 2]);
    expect(incoming).toEqual(outgoing);
    expect(edgeSites).toEqual(outgoing);
    for (const edge of report.edges) {
      const source = report.modules.find((group) => group.id === edge.from)!;
      const target = report.modules.find((group) => group.id === edge.to)!;
      for (const id of edge.importIds) {
        expect(source.files).toContain(report.imports[id]?.file);
        expect(target.files).toContain(report.imports[id]?.target);
      }
    }
  });

  it('selects a module by exact group ID or path while retaining consumers outside the selection', () => {
    const root = project(sources);
    const byId = sourceSystemReport(root, 'directory:src/core');
    const byPath = sourceSystemReport(root, './src/core/');
    expect(byId.modules).toEqual(byPath.modules);
    expect(byId.modules).toHaveLength(1);
    expect(byId.modules[0]?.consumers).toEqual(['src/api/run.ts', 'src/public/index.ts']);
    expect(byId.modules[0]?.incomingImportIds).toHaveLength(3);
    expect(byId.edges).toHaveLength(2);
    expect(sourceSystemReport(root, 'core').coverage.status).toBe('incomplete');
  });

  it('honors declared groups and flags forbidden imports without assigning business ownership', () => {
    const root = project({
      ...sources,
      '.scipquery.json': JSON.stringify({
        architecture: {
          boundaries: [
            { name: 'domain', paths: ['src/core/**'] },
            { name: 'delivery', paths: ['src/api/**'] },
          ],
          allowedDependencies: { delivery: [], domain: [] },
        },
      }),
    });
    const report = sourceSystemReport(root, 'boundary:delivery');
    expect(report.modules[0]).toMatchObject({ basis: 'declared-boundary', files: ['src/api/run.ts'] });
    expect(report.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ rule: 'architecture', evidence: 'derived' })]),
    );
    expect(report.edges).toEqual([expect.objectContaining({ from: 'boundary:delivery', to: 'boundary:domain' })]);
    expect(report.architecture.coverage.unmappedFiles).toHaveLength(2);
  });

  it('keeps type, deferred, test and unresolved relationships explicit', () => {
    const root = project({
      ...sources,
      'src/types/model.ts': 'export interface Value { amount: number }',
      'src/api/types.ts':
        'import type { Value } from "../types/model"; export type Copy = Value; export const load = () => import("../core/calculate");',
      'tests/run.test.ts': 'import { run } from "../src/api/run"; run();',
    });
    const production = sourceSystemReport(root);
    expect(production.modules.flatMap((group) => group.files)).not.toContain('tests/run.test.ts');
    expect(production.coverage.dependencies).toMatchObject({ typeOnly: 1, deferredOrCommonJs: 1 });
    const withTests = sourceSystemReport(root, 'directory:src/api', { includeTests: true });
    expect(withTests.modules[0]?.incomingImportIds.map((id) => withTests.imports[id])).toEqual([
      expect.objectContaining({ file: 'tests/run.test.ts', role: 'test' }),
    ]);
    expect(withTests.modules[0]?.consumers).not.toContain('tests/run.test.ts');
  });

  it('discloses bounded snapshots, parse failures, missing imports and unsupported exports', () => {
    const root = project({
      ...sources,
      'src/broken/bad.ts': 'export function broken( {',
      'src/missing/use.ts': 'import "./absent";',
      'src/cjs/index.js': 'module.exports = { run() { return 1; } };',
    });
    const report = sourceSystemReport(root);
    expect(report.coverage.status).toBe('incomplete');
    expect(report.coverage.dependencies.resolutions.missing).toBe(1);
    expect(report.modules.find((group) => group.id === 'directory:src/broken')?.exports).toEqual([]);
    expect(report.coverage.problems.some((problem) => problem.includes('src/broken/bad.ts'))).toBe(true);
    expect(report.coverage.limits.join(' ')).toContain('CommonJS exports');
    const bounded = sourceSystemReport(root, undefined, { maxFiles: 2 });
    expect(bounded.coverage).toMatchObject({ status: 'incomplete', capturedFiles: 2, eligibleFiles: 7 });
  });

  it('displays coverage, omitted counts and exact recovery instead of treating a preview as complete', () => {
    const report = sourceSystemReport(project(sources));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    renderSourceSystem(report, 1, 'scip-query system --source', (id) => `scip-query system --source '${id}'`);
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('Module groups (1/4 shown)');
    expect(output).toContain('Cross-group production dependencies (1/2 shown)');
    expect(output).toContain('scip-query system --source --full');
    expect(output).toContain('symbol consumers require indexed surface');
  });

  it('preserves indexed dispatch and rejects source-only controls before querying', () => {
    const indexed = vi.fn();
    const descriptor = withSourceSystem({
      id: 'system',
      command: 'system <module>',
      description: 'indexed',
      renderShape: 'custom',
      handler: indexed,
    });
    descriptor.handler('src/core', {});
    expect(indexed).toHaveBeenCalledWith('src/core', {});
    expect(() => descriptor.handler('src/core', { limit: 1 })).toThrow('requires system --source');
    expect(() => descriptor.handler(undefined, {})).toThrow('system --source');
    expect(indexed).toHaveBeenCalledTimes(1);
  });

  it('runs the actual CLI in a fresh repository without preparation and preserves role flags in recovery', () => {
    const root = project({ ...sources, 'tests/run.test.ts': 'import "../src/api/run";' });
    const cli = resolve('dist/cli.js');
    const output = join(root, 'module-evidence.json');
    execFileSync(process.execPath, [cli, 'system', '--source', '--include-tests', '--json', '--json-output', output], {
      cwd: root,
      timeout: 30000,
      stdio: 'pipe',
    });
    const packet = JSON.parse(readFileSync(output, 'utf8'));
    expect(packet.result.mode).toBe('source-system');
    expect(packet.result.modules.flatMap((group: { files: string[] }) => group.files)).toContain('tests/run.test.ts');
    expect(packet.coverage.complete).toBe(true);
    const human = execFileSync(
      process.execPath,
      [cli, 'system', '--source', 'directory:tests', '--include-tests', '--max-files', '100', '--limit', '1'],
      { cwd: root, timeout: 30000, encoding: 'utf8' },
    );
    expect(human).toContain("scip-query system --source 'directory:tests' --include-tests --max-files 100 --full");
    expect(existsSync(join(root, 'index.db'))).toBe(false);
  }, 60000);
});
