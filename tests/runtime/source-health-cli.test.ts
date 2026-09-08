import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sourceMaintenanceReport } from '../../src/queries/health/source-review.js';

const directories: string[] = [];
const cli = resolve('dist/cli.js');
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scan(files: Record<string, string>, args: string[] = []) {
  const directory = mkdtempSync(join(tmpdir(), 'scip-query-health-cli-'));
  directories.push(directory);
  const root = join(directory, 'project');
  mkdirSync(root);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  const artifact = join(directory, 'report.json');
  const result = spawnSync(process.execPath, [cli, 'health', '--check', '--json', '--json-output', artifact, ...args], {
    cwd: root,
    env: { ...process.env, SCIP_QUERY_PROJECT_ROOT: root, SCIP_QUERY_QUERY_SERVICE: '0' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  const envelope = JSON.parse(readFileSync(artifact, 'utf8'));
  return { root, status: result.status, report: envelope.result };
}

describe('source health CLI behavior without an index', () => {
  it('reports the same independently known cycle through the CLI and library', () => {
    const { root, status, report } = scan({
      'a.ts': "import { b } from './b.js'; export function a() { return b(); }",
      'b.ts': "import { a } from './a.js'; export function b() { return a(); }",
    });
    expect(status).toBe(1);
    expect(report.coverage).toMatchObject({ status: 'accounted', analyzedFiles: 2, eligibleFiles: 2 });
    expect(report.findings).toEqual(sourceMaintenanceReport(root).findings);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: 'dependency-cycle',
          sites: [
            { file: 'a.ts', line: 1 },
            { file: 'b.ts', line: 1 },
          ],
        }),
      ]),
    );
  });

  it('returns incomplete status for a parser failure even when no finding can be calculated', () => {
    const { status, report } = scan({ 'a.ts': 'export function broken( {' });
    expect(status).toBe(2);
    expect(report.coverage.status).toBe('incomplete');
    expect(report.coverage.problems.join()).toContain('a.ts');
  });

  it('does not pass a scan that omitted files because of its input budget', () => {
    const { status, report } = scan({ 'a.ts': 'export const a = 1;', 'b.ts': 'export const b = 2;' }, [
      '--max-files',
      '1',
    ]);
    expect(status).toBe(2);
    expect(report.coverage).toMatchObject({ status: 'incomplete', analyzedFiles: 1, eligibleFiles: 2 });
    expect(report.coverage.problems.join()).toContain('omitted');
  });

  it('does not treat an explicitly requested missing coverage file as zero or measured coverage', () => {
    const { status, report } = scan({ 'a.ts': 'export function a() { return 1; }' }, ['--coverage', 'missing.json']);
    expect(status).toBe(2);
    expect(report.coverage.testCoverage).toMatchObject({ requested: true, available: 0, unavailable: 1 });
    expect(report.coverage.problems.join()).toContain('coverage');
  });
});
