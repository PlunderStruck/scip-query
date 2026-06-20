import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { derivePackageSurface } from '../src/analysis/package-surface.js';

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
