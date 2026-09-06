import { describe, expect, it } from 'vitest';
import { analyzeSourceFunctions } from '../../src/source/ast/function-metrics.js';
import { maintenanceImports } from '../../src/source/ast/maintenance-imports.js';
import { maintenanceProject } from '../../src/source/primitives/maintenance-project.js';

function analyze(entries: Record<string, string>, file = 'src/main.ts') {
  const files = new Map(Object.entries(entries));
  const source = analyzeSourceFunctions(file, files.get(file)!);
  const project = maintenanceProject(
    [...files.keys()],
    [...files.keys()].filter((file) => /\.[jt]s$/.test(file)),
    (file) => files.get(file),
  );
  const imports = maintenanceImports(source.sourceFile, files, project, source.checker);
  return { imports, project };
}

describe('captured compiler import configuration', () => {
  it('resolves inherited JSONC paths relative to the configuration that declares them', () => {
    const { imports, project } = analyze({
      'tsconfig.json': '{"extends":"./config/base.json","include":["src"]}',
      'config/base.json': '{ // base\n "compilerOptions":{"baseUrl":"..","paths":{"@/*":["src/*"]},},}',
      'src/main.ts': "import { value } from '@/value'; export const run = () => value;",
      'src/value.ts': 'export const value = 1;',
    });
    expect(project.problems).toEqual([]);
    expect(imports).toMatchObject([{ target: 'src/value.ts', resolution: 'internal', configs: ['tsconfig.json'] }]);
    expect([...project.inputs.keys()]).toContain('config/base.json');
  });

  it('selects referenced projects by their compiler file membership', () => {
    const { imports, project } = analyze({
      'tsconfig.json': '{"files":[],"references":[{"path":"./tsconfig.app.json"},{"path":"./tsconfig.tooling.json"}]}',
      'tsconfig.app.json': '{"compilerOptions":{"paths":{"@/*":["./src/*"]}},"include":["src"]}',
      'tsconfig.tooling.json': '{"compilerOptions":{"paths":{"@/*":["./scripts/*"]}},"include":["scripts"]}',
      'src/main.ts': "import { value } from '@/value';",
      'src/value.ts': 'export const value = 1;',
      'scripts/value.ts': 'export const value = 2;',
    });
    expect(project.problems).toEqual([]);
    expect(imports).toMatchObject([{ target: 'src/value.ts', configs: ['tsconfig.app.json'] }]);
  });

  it('resolves repository package exports through captured package metadata', () => {
    const { imports, project } = analyze({
      'tsconfig.json': '{"compilerOptions":{"module":"ESNext","moduleResolution":"bundler"}}',
      'src/main.ts': "import { value } from '@acme/shared/value';",
      'packages/shared/package.json': '{"name":"@acme/shared","exports":{"./value":"./src/value.ts"}}',
      'packages/shared/src/value.ts': 'export const value = 1;',
    });
    expect(project.problems).toEqual([]);
    expect(imports).toMatchObject([{ target: 'packages/shared/src/value.ts', resolution: 'internal' }]);
  });

  it('distinguishes missing internal imports, packages, builtins and type-only dependencies', () => {
    const { imports } = analyze({
      'tsconfig.json': '{"compilerOptions":{"paths":{"@/*":["./src/*"]}}}',
      'src/main.ts':
        "import { type Value } from '@/value'; import '@/missing'; import 'react'; import 'node:fs'; export { type Value } from '@/value';",
      'src/value.ts': 'export type Value = string;',
    });
    expect(imports.map(({ resolution, kind }) => ({ resolution, kind }))).toEqual([
      { resolution: 'internal', kind: 'type' },
      { resolution: 'missing', kind: 'value' },
      { resolution: 'external', kind: 'value' },
      { resolution: 'builtin', kind: 'value' },
      { resolution: 'internal', kind: 'type' },
    ]);
  });

  it('keeps ambiguous compiler project interpretations unresolved', () => {
    const { imports } = analyze({
      'tsconfig.json': '{"files":[],"references":[{"path":"./tsconfig.a.json"},{"path":"./tsconfig.b.json"}]}',
      'tsconfig.a.json': '{"compilerOptions":{"paths":{"@value":["./src/a.ts"]}},"include":["src"]}',
      'tsconfig.b.json': '{"compilerOptions":{"paths":{"@value":["./src/b.ts"]}},"include":["src"]}',
      'src/main.ts': "import { value } from '@value';",
      'src/a.ts': 'export const value = 1;',
      'src/b.ts': 'export const value = 2;',
    });
    expect(imports[0]).toMatchObject({ resolution: 'ambiguous', alternatives: ['src/a.ts', 'src/b.ts'] });
    expect(imports[0]?.target).toBeUndefined();
  });

  it('does not interpret a locally bound require function as an import', () => {
    const { imports } = analyze({
      'src/main.ts':
        "const actual = require('./value'); function custom(require) { return require('./not-an-import'); } const deferred = import('./value'); const unknown = import(actual.path);",
      'src/value.ts': 'export const value = 1;',
    });
    expect(imports.map((item) => [item.syntax, item.resolution])).toEqual([
      ['require', 'internal'],
      ['dynamic-import', 'internal'],
      ['dynamic-import', 'dynamic'],
    ]);
  });

  it('reports unavailable inherited settings without reading outside the inventory', () => {
    const { project } = analyze({
      'tsconfig.json': '{"extends":"../outside/tsconfig.json"}',
      'src/main.ts': 'export const value = 1;',
    });
    expect(project.problems.join()).toContain('outside/tsconfig.json');
    expect([...project.inputs.keys()]).toEqual(['tsconfig.json']);
  });
});
