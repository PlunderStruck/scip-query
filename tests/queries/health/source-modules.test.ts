import { describe, expect, it } from 'vitest';
import { analyzeSourceSnapshot } from '../../../src/queries/health/source-findings.js';
import { sourceModuleSubjects } from '../../../src/queries/health/source-modules.js';
import { maintenanceProject } from '../../../src/source/primitives/maintenance-project.js';

const body = (call: string) =>
  `const values = input.filter(item => item.enabled); const selected = values.map(item => ${call}(item.value)); const total = selected.reduce((sum, item) => sum + item, 0); if (total > 10) return { total, count: values.length, large: true }; return { total, count: values.length, large: false };`;
function analyze(
  extra = '',
  consumers = "import { alpha, beta } from './owner';",
  secondConsumer = "import { gamma, delta } from './owner';",
) {
  const files = new Map(
    Object.entries({
      'owner.ts': `import { a } from './a'; import { b } from './b'; ${extra}
      export function alpha(input) { ${body('a')} }
      export function beta(input) { ${body('a')} }
      export function gamma(input) { ${body('b')} }
      export function delta(input) { ${body('b')} }`,
      'a.ts': 'export const a = x => x;',
      'b.ts': 'export const b = x => x;',
      'consumer-a.ts': consumers,
      'consumer-b.ts': secondConsumer,
    }),
  );
  const project = maintenanceProject([...files.keys()], [...files.keys()], (file) => files.get(file));
  return analyzeSourceSnapshot({
    revision: 'test',
    files,
    fingerprint: 'test',
    eligibleFiles: files.size,
    excludedFiles: 0,
    exclusions: {},
    project,
    problems: [],
  });
}

describe('module planning evidence', () => {
  it('identifies separate substantial implementations, dependencies and named consumer groups', () => {
    const result = analyze();
    const finding = result.findings.find((item) => item.rule === 'responsibility');
    expect(finding).toMatchObject({
      evidence: 'candidate',
      score: 2,
      sites: expect.arrayContaining([
        expect.objectContaining({ name: 'alpha' }),
        expect.objectContaining({ name: 'delta' }),
      ]),
    });
    expect(finding?.details.join('\n')).toContain('consumer-a.ts:1 (alpha)');
    expect(finding?.details.join('\n')).toContain('shared public contract');
    const modules = sourceModuleSubjects([...result.graph.keys()], result.imports, result.findings);
    expect(modules[0]).toMatchObject({ basis: 'directory', findingIds: expect.arrayContaining([finding!.id]) });
  });

  it('does not suggest independent ownership when consumers use both groups', () => {
    expect(
      analyze('', "import { alpha, gamma } from './owner';").findings.filter((item) => item.rule === 'responsibility'),
    ).toEqual([]);
    expect(
      analyze('', "import * as owner from './owner';").findings.filter((item) => item.rule === 'responsibility'),
    ).toEqual([]);
  });

  it('keeps orchestration that connects the groups together', () => {
    const result = analyze('export function together(input) { return [alpha(input), gamma(input)]; }');
    expect(result.findings.filter((item) => item.rule === 'responsibility')).toEqual([]);
  });
});

it('does not attribute small-export consumers to unconsumed substantial functions', () => {
  const result = analyze(
    'export function smallA(x) { return a(x); } export function smallB(x) { return b(x); }',
    "import { smallA } from './owner';",
    "import { smallB } from './owner';",
  );
  expect(result.findings.filter((item) => item.rule === 'responsibility')).toEqual([]);
});
