import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { derivePackageOperationalSurface, derivePackageSurface } from '../../src/analysis/package-surface.js';

let tempRoot: string | undefined;

function projectWithManifest(manifest: unknown): string {
  tempRoot = mkdtempSync(join(tmpdir(), 'scip-package-surface-'));
  writeFileSync(join(tempRoot, 'package.json'), JSON.stringify(manifest));
  return tempRoot;
}

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

describe('derivePackageSurface', () => {
  it('returns an empty surface when package.json is missing or invalid', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'scip-package-surface-'));
    expect(derivePackageSurface(tempRoot).files.size).toBe(0);

    writeFileSync(join(tempRoot, 'package.json'), 'not json');
    expect(derivePackageSurface(tempRoot).files.size).toBe(0);
  });

  it('maps dist export targets back to src source candidates', () => {
    const root = projectWithManifest({
      exports: {
        './queries/plan-context': {
          import: './dist/queries/plan-context.js',
          types: './dist/queries/plan-context.d.ts',
        },
      },
    });
    mkdirSync(join(root, 'src/queries/impact'), { recursive: true });
    writeFileSync(join(root, 'src/queries/impact/plan-context.ts'), '');

    const surface = derivePackageSurface(root);
    expect(surface.files.has('src/queries/impact/plan-context.ts')).toBe(true);
    expect(surface.files.has('dist/queries/plan-context.js')).toBe(true);
    expect(surface.files.has('queries/plan-context.ts')).toBe(true);
  });

  it('collects main, module, types, browser, and bin targets', () => {
    const root = projectWithManifest({
      main: './dist/index.js',
      module: 'dist/index.mjs',
      types: './dist/index.d.ts',
      browser: './dist/browser.js',
      bin: { 'my-cli': './dist/cli.js' },
    });

    const surface = derivePackageSurface(root);
    expect(surface.files.has('src/index.ts')).toBe(true);
    expect(surface.files.has('src/browser.ts')).toBe(true);
    expect(surface.files.has('src/cli.ts')).toBe(true);
  });

  it('maps package entry targets to source directory index files', () => {
    const root = projectWithManifest({
      exports: {
        './runtime': {
          import: './dist/runtime.js',
          types: './dist/runtime.d.ts',
        },
      },
    });
    mkdirSync(join(root, 'src/runtime'), { recursive: true });
    writeFileSync(join(root, 'src/runtime/index.ts'), '');

    const surface = derivePackageSurface(root);
    expect(surface.files.has('src/runtime/index.ts')).toBe(true);
  });

  it('derives surfaces from nested package manifests', () => {
    const root = projectWithManifest({});
    mkdirSync(join(root, 'packages/shared/src/schemas'), { recursive: true });
    writeFileSync(join(root, 'packages/shared/src/schemas/index.ts'), '');
    writeFileSync(
      join(root, 'packages/shared/package.json'),
      JSON.stringify({
        name: '@fixture/shared',
        exports: {
          './schemas': {
            import: './dist/schemas/index.js',
            types: './dist/schemas/index.d.ts',
          },
        },
      }),
    );

    const surface = derivePackageSurface(root);
    expect(surface.files.has('packages/shared/src/schemas/index.ts')).toBe(true);
  });

  it('supports string bin and source-published targets verbatim', () => {
    const root = projectWithManifest({
      bin: './cli.mjs',
      exports: { '.': './index.ts' },
    });

    const surface = derivePackageSurface(root);
    expect(surface.files.has('cli.mjs')).toBe(true);
    expect(surface.files.has('index.ts')).toBe(true);
  });

  it('turns wildcard exports into path prefixes', () => {
    const root = projectWithManifest({
      exports: { './queries/*': './dist/queries/*.js' },
    });

    const surface = derivePackageSurface(root);
    expect(surface.pathPrefixes).toContain('dist/queries/');
    expect(surface.pathPrefixes).toContain('src/queries/');
  });

  it('ignores targets escaping the project root', () => {
    const root = projectWithManifest({ exports: { '.': '../outside.js' } });
    expect(derivePackageSurface(root).files.size).toBe(0);
  });
});

describe('derivePackageOperationalSurface', () => {
  it('distinguishes binary and executable package-script roots from ordinary script arguments', () => {
    const root = projectWithManifest({
      bin: { tool: './dist/cli.js' },
      scripts: {
        release: 'vite-node scripts/release.ts --dry-run',
        lint: 'eslint src/runtime/watch-server.ts',
        chained: 'npm run build && node scripts/audit.mjs',
      },
    });

    const reasons = derivePackageOperationalSurface(root).reasonsByFile;
    expect(reasons.get('src/cli.ts')).toContain('package binary');
    expect(reasons.get('scripts/release.ts')).toContain('package script "release"');
    expect(reasons.get('scripts/audit.mjs')).toContain('package script "chained"');
    expect(reasons.has('src/runtime/watch-server.ts')).toBe(false);
  });
});
