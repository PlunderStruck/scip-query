import assert from 'node:assert/strict';
import fc from 'fast-check';
import { it } from 'vitest';
import { setImmediate } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sourceMaintenanceReport } from '../../src/queries/health/source-review.js';
import { withGitProject } from './fixture.js';
import { analyzeSourceFunctions } from '../../src/source/ast/function-metrics.js';
import { checkProperty, PROPERTY_TIMEOUT } from './support.js';

const branch = fc.record({ depth: fc.integer({ min: 1, max: 5 }), alternatives: fc.boolean(), loop: fc.boolean() });

function source(
  branches: readonly { depth: number; alternatives: boolean; loop: boolean }[],
  value: number,
  local: string,
): string {
  const body = branches
    .map(({ depth, alternatives, loop }) => {
      const opens = Array.from({ length: depth }, (_, n) =>
        loop && n === 0 ? 'while (input > 0) {' : 'if (input > 0) {',
      ).join('\n');
      const closes = Array.from({ length: depth }, () => (alternatives ? '} else { input = 0; }' : '}'));
      if (loop && alternatives) closes[depth - 1] = '}';
      return `${opens}\n${local} += input;\n${closes.join('\n')}`;
    })
    .join('\n');
  return `function measured(input: number) { let ${local} = ${value};\n${body}\nreturn { result: ${local} }; }`;
}

it(
  'scanner: generated branches have exact metrics and duplication preserves semantic differences',
  async () => {
    let cases = 0;
    await checkProperty(
      'scanner',
      'known-source-metrics-and-duplicates',
      fc.asyncProperty(
        fc.array(branch, { maxLength: 5 }),
        fc.integer({ min: -1000, max: 1000 }),
        async (branches, value) => {
          // Long source-generation runs must let Vitest deliver its worker RPCs.
          if (cases++ % 100 === 0) await setImmediate();
          const original = source(branches, value, 'total');
          const analyze = (code: string) => {
            const result = analyzeSourceFunctions('fixture.ts', code);
            assert.deepEqual(result.errors, []);
            assert.equal(result.functions.length, 1);
            return result.functions[0]!;
          };
          const fn = analyze(original);
          assert.equal(fn.cyclomatic, 1 + branches.reduce((sum, item) => sum + item.depth, 0));
          const cognitive = branches.reduce(
            (sum, item) =>
              sum + (item.depth * (item.depth + 1)) / 2 + (item.alternatives ? item.depth - Number(item.loop) : 0),
            0,
          );
          assert.equal(fn.cognitive, cognitive);
          const renamed = analyze(source(branches, value, 'answer'));
          assert.equal(fn.renamedBodyHash, renamed.renamedBodyHash);
          assert.notEqual(fn.renamedBodyHash, analyze(source(branches, value + 1, 'total')).renamedBodyHash);
          const decorated = analyze(original.replace('let total', '/* if (false) { while (true) {} } */\nlet total'));
          assert.equal(fn.bodyHash, decorated.bodyHash);
          assert.equal(fn.cyclomatic, decorated.cyclomatic);
          const broken = analyzeSourceFunctions('fixture.ts', original.slice(0, -1));
          assert.ok(broken.errors.length > 0);
          assert.deepEqual(broken.functions, []);
        },
      ),
    );
  },
  PROPERTY_TIMEOUT,
);

it(
  'scanner: first-use health reports identify planted complexity, current edits and scan incompleteness',
  async () => {
    await checkProperty(
      'scanner',
      'first-use-health',
      fc.property(fc.integer({ min: 1, max: 20 }), fc.boolean(), (count, corrupt) => {
        const code = `export function work(input: number) { ${'if (input > 0) input--; '.repeat(count)} return input; }`;
        withGitProject({ 'src/work.ts': code, 'src/quiet.ts': 'export const quiet = 1;' }, (root) => {
          const report = sourceMaintenanceReport(root);
          assert.equal(report.coverage.status, 'accounted');
          assert.equal(report.coverage.analyzedFiles, 2);
          assert.equal(report.coverage.analyzedFunctions, 1);
          assert.equal(
            report.findings.some((finding) => finding.rule === 'complexity'),
            count + 1 > 10 || count > 15,
          );
          const limited = sourceMaintenanceReport(root, { maxFiles: 1 });
          assert.equal(limited.coverage.status, 'incomplete');
          assert.ok(limited.coverage.problems.length > 0);
          writeFileSync(
            join(root, 'src/work.ts'),
            corrupt ? 'export function work( {' : 'export function work(input: number) { return input; }',
          );
          const changed = sourceMaintenanceReport(root);
          assert.equal(changed.coverage.status, corrupt ? 'incomplete' : 'accounted');
          assert.equal(
            changed.findings.some((finding) => finding.rule === 'complexity'),
            false,
          );
          if (corrupt) assert.ok(changed.coverage.problems.length > 0);
        });
      }),
      'integration',
    );
  },
  PROPERTY_TIMEOUT,
);
