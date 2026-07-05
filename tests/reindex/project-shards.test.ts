import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProjectFileFingerprint } from '../../src/reindex/project-files.js';
import {
  assignFilesToProjects,
  computeProjectShardFingerprints,
  deriveProjectDependencies,
  projectShardSlug,
  readProjectManifestInputs,
  type ProjectManifestInputs,
} from '../../src/reindex/project-shards.js';

const tempDirs: string[] = [];

function createTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scip-query-project-shards-'));
  tempDirs.push(dir);
  return dir;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeRaw(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fp(path: string): ProjectFileFingerprint {
  return { path, size: path.length, hash: `hash:${path}` };
}

function emptyInputs(projects: readonly string[]): ProjectManifestInputs {
  return Object.fromEntries(
    projects.map((project) => [
      project,
      { packageName: undefined, dependencyNames: [], pathsTargets: [], referencesPaths: [], parseFailed: false },
    ]),
  );
}

describe('assignFilesToProjects', () => {
  it('claims each file for the most specific (longest prefix) project', () => {
    const projects = ['.', 'packages/a', 'packages/a/nested'];
    const files = [
      fp('packages/a/x.ts'),
      fp('packages/a/nested/y.ts'),
      fp('packages/a/nested/deep/z.ts'),
      fp('README.md'),
    ];

    const assignment = assignFilesToProjects(files, projects);

    expect(assignment.files['packages/a']!.map((f) => f.path)).toEqual(['packages/a/x.ts']);
    expect(assignment.files['packages/a/nested']!.map((f) => f.path)).toEqual([
      'packages/a/nested/y.ts',
      'packages/a/nested/deep/z.ts',
    ]);
    expect(assignment.files['.']!.map((f) => f.path)).toEqual(['README.md']);
    expect(assignment.shared).toEqual([]);
  });

  it('does not match a sibling directory whose name is a superstring (boundary on "/")', () => {
    const projects = ['apps/web'];
    const files = [fp('apps/web/x.ts'), fp('apps/web2/x.ts')];

    const assignment = assignFilesToProjects(files, projects);

    expect(assignment.files['apps/web']!.map((f) => f.path)).toEqual(['apps/web/x.ts']);
    expect(assignment.shared.map((f) => f.path)).toEqual(['apps/web2/x.ts']);
  });

  it('lets the root project claim every unclaimed file when present', () => {
    const projects = ['.', 'packages/a'];
    const files = [fp('packages/a/x.ts'), fp('other.ts'), fp('README.md')];

    const assignment = assignFilesToProjects(files, projects);

    expect(assignment.files['.']!.map((f) => f.path).sort()).toEqual(['README.md', 'other.ts']);
    expect(assignment.shared).toEqual([]);
  });

  it('puts unclaimed files in a shared bucket when there is no root project', () => {
    const projects = ['apps/web', 'apps/api'];
    const files = [fp('apps/web/x.ts'), fp('apps/api/y.ts'), fp('README.md')];

    const assignment = assignFilesToProjects(files, projects);

    expect(assignment.files['apps/web']!.map((f) => f.path)).toEqual(['apps/web/x.ts']);
    expect(assignment.files['apps/api']!.map((f) => f.path)).toEqual(['apps/api/y.ts']);
    expect(assignment.shared.map((f) => f.path)).toEqual(['README.md']);
  });
});

describe('deriveProjectDependencies', () => {
  it("adds an edge when a dependency name matches another project's package name", () => {
    const projects = ['apps/web', 'packages/shared'];
    const inputs: ProjectManifestInputs = {
      'apps/web': {
        packageName: '@app/web',
        dependencyNames: ['@app/shared'],
        pathsTargets: [],
        referencesPaths: [],
        parseFailed: false,
      },
      'packages/shared': {
        packageName: '@app/shared',
        dependencyNames: [],
        pathsTargets: [],
        referencesPaths: [],
        parseFailed: false,
      },
    };

    const deps = deriveProjectDependencies(projects, inputs);

    expect(deps['apps/web']).toEqual(['packages/shared']);
    expect(deps['packages/shared']).toEqual([]);
  });

  it('adds an edge when a tsconfig paths/references target resolves under another project dir', () => {
    const projects = ['apps/web', 'packages/shared'];
    const inputs: ProjectManifestInputs = {
      'apps/web': {
        packageName: undefined,
        dependencyNames: [],
        pathsTargets: ['packages/shared/src'],
        referencesPaths: [],
        parseFailed: false,
      },
      'packages/shared': {
        packageName: undefined,
        dependencyNames: [],
        pathsTargets: [],
        referencesPaths: [],
        parseFailed: false,
      },
    };

    const deps = deriveProjectDependencies(projects, inputs);

    expect(deps['apps/web']).toEqual(['packages/shared']);
  });

  it('adds an edge for a references[].path target too', () => {
    const projects = ['apps/web', 'packages/shared'];
    const inputs: ProjectManifestInputs = {
      'apps/web': {
        packageName: undefined,
        dependencyNames: [],
        pathsTargets: [],
        referencesPaths: ['packages/shared'],
        parseFailed: false,
      },
      'packages/shared': {
        packageName: undefined,
        dependencyNames: [],
        pathsTargets: [],
        referencesPaths: [],
        parseFailed: false,
      },
    };

    const deps = deriveProjectDependencies(projects, inputs);

    expect(deps['apps/web']).toEqual(['packages/shared']);
  });

  it('makes a project with parseFailed depend on all other projects', () => {
    const projects = ['apps/web', 'apps/api', 'packages/shared'];
    const inputs: ProjectManifestInputs = {
      ...emptyInputs(projects),
      'apps/web': {
        packageName: undefined,
        dependencyNames: [],
        pathsTargets: [],
        referencesPaths: [],
        parseFailed: true,
      },
    };

    const deps = deriveProjectDependencies(projects, inputs);

    expect(deps['apps/web']).toEqual(['apps/api', 'packages/shared']);
  });

  it('returns the transitive closure of dependency edges', () => {
    const projects = ['a', 'b', 'c'];
    const inputs: ProjectManifestInputs = {
      a: { packageName: '@x/a', dependencyNames: ['@x/b'], pathsTargets: [], referencesPaths: [], parseFailed: false },
      b: { packageName: '@x/b', dependencyNames: ['@x/c'], pathsTargets: [], referencesPaths: [], parseFailed: false },
      c: { packageName: '@x/c', dependencyNames: [], pathsTargets: [], referencesPaths: [], parseFailed: false },
    };

    const deps = deriveProjectDependencies(projects, inputs);

    expect(deps.a).toEqual(['b', 'c']);
    expect(deps.b).toEqual(['c']);
    expect(deps.c).toEqual([]);
  });

  it("does not add a self edge when a project's own paths target resolves to itself", () => {
    const projects = ['apps/web', 'packages/shared'];
    const inputs: ProjectManifestInputs = {
      'apps/web': {
        packageName: undefined,
        dependencyNames: [],
        pathsTargets: ['apps/web/src'],
        referencesPaths: [],
        parseFailed: false,
      },
      'packages/shared': emptyInputs(['packages/shared'])['packages/shared']!,
    };

    const deps = deriveProjectDependencies(projects, inputs);

    expect(deps['apps/web']).toEqual([]);
  });
});

function byLocale(paths: string[]): string[] {
  return [...paths].sort((left, right) => left.localeCompare(right));
}

describe('computeProjectShardFingerprints', () => {
  it('unions own files with transitive dependency files and the shared bucket, sorted and deduplicated', () => {
    const projects = ['apps/web', 'apps/api', 'packages/shared'];
    const files = [
      fp('apps/web/b.ts'),
      fp('apps/web/a.ts'),
      fp('apps/api/x.ts'),
      fp('packages/shared/s.ts'),
      fp('README.md'),
    ];
    const assignment = assignFilesToProjects(files, projects);
    const dependencies = { 'apps/web': ['packages/shared'], 'apps/api': [], 'packages/shared': [] };

    const fingerprints = computeProjectShardFingerprints(projects, assignment, dependencies);

    expect(fingerprints['apps/web']!.files.map((f) => f.path)).toEqual(
      byLocale(['apps/web/a.ts', 'apps/web/b.ts', 'packages/shared/s.ts', 'README.md']),
    );
    expect(fingerprints['apps/api']!.files.map((f) => f.path)).toEqual(byLocale(['apps/api/x.ts', 'README.md']));
    expect(fingerprints['packages/shared']!.files.map((f) => f.path)).toEqual(
      byLocale(['packages/shared/s.ts', 'README.md']),
    );
  });
});

describe('projectShardSlug', () => {
  it('maps the root project to the readable "root" slug', () => {
    expect(projectShardSlug('.')).toBe('root');
  });

  it('is stable across repeated calls for the same project', () => {
    expect(projectShardSlug('apps/web')).toBe(projectShardSlug('apps/web'));
  });

  it('is filesystem-safe (no "/" in the slug)', () => {
    expect(projectShardSlug('apps/web')).not.toContain('/');
    expect(projectShardSlug('apps/web')).toMatch(/^apps__web-[0-9a-f]{8}$/);
  });

  it('never collides between distinct project paths, including a naive-replacement collision', () => {
    const slugA = projectShardSlug('apps/web');
    const slugB = projectShardSlug('apps/api');
    const slugC = projectShardSlug('apps__web'); // would collide with 'apps/web' under naive '/'->'__' replacement alone
    expect(slugA).not.toBe(slugB);
    expect(slugA).not.toBe(slugC);
  });
});

describe('readProjectManifestInputs', () => {
  it('detects a paths-based dependency edge through an extends chain, base config defined outside the project dir', () => {
    const root = createTempRoot();
    writeRaw(
      join(root, 'tsconfig.base.json'),
      `{
        // shared compiler options for every project
        "compilerOptions": {
          "paths": {
            "@app/shared/*": ["./packages/shared/src/*"]
          }
        }
      }`,
    );
    writeJson(join(root, 'apps/web/tsconfig.json'), {
      extends: '../../tsconfig.base.json',
      compilerOptions: { outDir: 'dist' },
    });
    writeJson(join(root, 'apps/web/package.json'), { name: '@app/web', dependencies: {} });
    writeJson(join(root, 'packages/shared/package.json'), { name: '@app/shared' });
    writeJson(join(root, 'packages/shared/tsconfig.json'), { compilerOptions: { outDir: 'dist' } });

    const projects = ['apps/web', 'packages/shared'];
    const inputs = readProjectManifestInputs(root, projects);

    expect(inputs['apps/web']!.parseFailed).toBe(false);
    expect(inputs['apps/web']!.pathsTargets).toEqual(['packages/shared/src']);

    const deps = deriveProjectDependencies(projects, inputs);
    expect(deps['apps/web']).toEqual(['packages/shared']);
  });

  it('reads package.json name and dependency names', () => {
    const root = createTempRoot();
    writeJson(join(root, 'apps/web/package.json'), {
      name: '@app/web',
      dependencies: { '@app/shared': '1.0.0' },
      devDependencies: { typescript: '5.0.0' },
      peerDependencies: { react: '18.0.0' },
    });

    const inputs = readProjectManifestInputs(root, ['apps/web']);

    expect(inputs['apps/web']!.packageName).toBe('@app/web');
    expect(inputs['apps/web']!.dependencyNames.sort()).toEqual(['@app/shared', 'react', 'typescript']);
    expect(inputs['apps/web']!.parseFailed).toBe(false);
  });

  it('does not treat a missing package.json or tsconfig as a failure', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'apps/web'), { recursive: true });

    const inputs = readProjectManifestInputs(root, ['apps/web']);

    expect(inputs['apps/web']).toEqual({
      packageName: undefined,
      dependencyNames: [],
      pathsTargets: [],
      referencesPaths: [],
      parseFailed: false,
    });
  });

  it('sets parseFailed when package.json exists but is unparseable', () => {
    const root = createTempRoot();
    writeRaw(join(root, 'apps/web/package.json'), '{ this is not json ');

    const inputs = readProjectManifestInputs(root, ['apps/web']);

    expect(inputs['apps/web']!.parseFailed).toBe(true);
  });

  it('sets parseFailed when the tsconfig exists but is unparseable', () => {
    const root = createTempRoot();
    writeRaw(join(root, 'apps/web/tsconfig.json'), '{ this is not json ');

    const inputs = readProjectManifestInputs(root, ['apps/web']);

    expect(inputs['apps/web']!.parseFailed).toBe(true);
  });

  it('strips // and /* */ comments without corrupting "//" or "/* */"-like text inside string literals', () => {
    const root = createTempRoot();
    writeRaw(
      join(root, 'apps/web/package.json'),
      `{
        // real comment: package identity
        "name": "@app/weird" /* trailing comment */,
        "description": "see http://example.com, note: /* not code */ still a string",
        "dependencies": {
          "@app/shared": "1.0.0"
        }
      }`,
    );

    const inputs = readProjectManifestInputs(root, ['apps/web']);

    expect(inputs['apps/web']!.parseFailed).toBe(false);
    expect(inputs['apps/web']!.packageName).toBe('@app/weird');
    expect(inputs['apps/web']!.dependencyNames).toEqual(['@app/shared']);
  });
});
