import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Windows SCIP sidecar documentation', () => {
  it('keeps the checked-in README and its generator on the npm-sidecar release path', () => {
    const readme = readFileSync('packages/scip-windows/README.md', 'utf8');
    const generator = readFileSync('scripts/build-scip-windows.mjs', 'utf8');

    for (const content of [readme, generator]) {
      expect(content).toContain('scip-query-scip-windows');
      expect(content).toContain('optional dependency');
      expect(content).not.toContain('scip-windows-assets.ts');
      expect(content).not.toContain('GitHub release asset');
    }
  });

  it('gates direct npm publish and exposes the complete release coordinator', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const prepublishOnly = packageJson.scripts?.['prepublishOnly'];

    expect(prepublishOnly).toBe('vite-node scripts/release-npm-guard.ts');
    expect(packageJson.scripts?.['release:npm']).toBe('vite-node scripts/release-npm.ts');
    expect(packageJson.scripts?.['release:npm:dry-run']).toBe('vite-node scripts/release-npm.ts --dry-run');
    expect(packageJson.scripts?.['verify:scip-windows']).toBe('node scripts/verify-scip-windows.mjs');
    expect(packageJson.scripts?.['verify:scip-windows-registry']).toBe(
      'vite-node scripts/verify-scip-windows-registry.ts',
    );
  });

  it('verifies provenance again when the sidecar itself is packed', () => {
    const sidecar = JSON.parse(readFileSync('packages/scip-windows/package.json', 'utf8')) as {
      files?: string[];
      scripts?: Record<string, string>;
    };

    expect(sidecar.files).toContain('provenance.json');
    expect(sidecar.scripts?.['prepack']).toBe('node ../../scripts/verify-scip-windows.mjs');
  });

  it('keeps durable release state local and documents the direct-publish refusal', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      version?: string;
      optionalDependencies?: Record<string, string>;
    };
    const ignored = readFileSync('.gitignore', 'utf8');
    const guard = readFileSync('scripts/release-npm-guard.ts', 'utf8');
    const releaseGuide = readFileSync('docs/WINDOWS_SIDECAR_RELEASE.md', 'utf8');

    expect(packageJson.version).toBe('0.19.6');
    expect(packageJson.optionalDependencies?.['scip-query-scip-windows']).toBe('0.13.1');
    expect(ignored).toContain('/.scipquery/releases/');
    expect(guard).toContain('Direct npm publish is disabled');
    expect(guard).toContain('npm run release:npm');
    expect(releaseGuide).toContain('npm run release:npm:dry-run');
    expect(releaseGuide).toContain('Sidecar publishes but its state write fails');
    expect(releaseGuide).toContain('Main is exact, sidecar is absent');
    expect(releaseGuide).toMatch(/administrative\s+capability outside the repository's enforcement boundary/);
    expect(releaseGuide).toContain('docs/schemas/npm-release-state.schema.json');
  });
});
