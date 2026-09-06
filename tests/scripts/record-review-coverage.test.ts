import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { recordReviewCoverage } from '../../scripts/record-review-coverage.mjs';
import { sourceMaintenanceReport } from '../../src/queries/health/source-review.js';
import { analyzeSourceFunctions } from '../../src/source/ast/function-metrics.js';
import { functionCoverage, loadReviewCoverage } from '../../src/source/maintenance-coverage.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'scip-real-coverage-')));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, 'rule.js'), 'function run(x) {\n if (x) return 1;\n return 0;\n}');
  return root;
}

it('records actual execution counts and refuses them after a source edit', () => {
  const root = fixture();
  // Instrument the fixture's branches and execute one of its two outcomes.
  const runner = `const fs = require('fs'), vm = require('vm'), assert = require('assert');
    const counts = { '0': 0, '1': 0 };
    const source = fs.readFileSync('rule.js', 'utf8').replace('if (x)', 'counts[0]++; if (x)').replace('return 0;', 'counts[1]++; return 0;');
    const context = { counts }; vm.runInNewContext(source, context); assert.equal(context.run(true), 1);
    fs.writeFileSync('coverage.json', JSON.stringify({ 'rule.js': { path: 'rule.js', statementMap: {
      '0': { start: { line: 2, column: 1 } }, '1': { start: { line: 3, column: 1 } }
    }, s: counts } }));`;
  recordReviewCoverage({
    root,
    input: 'coverage.json',
    output: 'receipt.json',
    command: process.execPath,
    args: ['-e', runner],
  });
  const receipt = JSON.parse(readFileSync(join(root, 'receipt.json'), 'utf8'));
  expect(receipt.files['rule.js'].coverage.s).toEqual({ '0': 1, '1': 0 });
  const report = sourceMaintenanceReport(root, { coverage: 'receipt.json' });
  expect(report.coverage.status).toBe('accounted');
  const measured = () => {
    const source = readFileSync(join(root, 'rule.js'), 'utf8');
    const functions = analyzeSourceFunctions('rule.js', source).functions;
    return functionCoverage(functions[0]!, functions, source, loadReviewCoverage(root, 'receipt.json'));
  };
  expect(measured()).toMatchObject({ status: 'available', fraction: 0.5, crap: 2.5 });
  writeFileSync(join(root, 'rule.js'), 'function run(x) {\n if (x) return 2;\n return 0;\n}');
  expect(measured()).toMatchObject({ status: 'unavailable' });
});

it('rejects a successful command that did not produce coverage', () => {
  const root = fixture();
  writeFileSync(join(root, 'coverage.json'), '{}');
  expect(() =>
    recordReviewCoverage({
      root,
      input: 'coverage.json',
      output: 'receipt.json',
      command: process.execPath,
      args: ['-e', ''],
    }),
  ).toThrow('fresh coverage');
});

it('rejects source changes during the test command', () => {
  const root = fixture();
  expect(() =>
    recordReviewCoverage({
      root,
      input: 'coverage.json',
      output: 'receipt.json',
      command: process.execPath,
      args: [
        '-e',
        "require('fs').appendFileSync('rule.js', '\\n'); require('fs').writeFileSync('coverage.json', '{}');",
      ],
    }),
  ).toThrow('Source changed');
});
