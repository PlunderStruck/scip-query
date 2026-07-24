/**
 * pnpm/npm/yarn workspace-package specifier resolution
 * (`@scope/pkg`, `@scope/pkg/subpath`) for the JS/TS import-path resolver.
 *
 * Before this, a bare specifier that wasn't a tsconfig `paths` alias always
 * returned `null` — including workspace package names, which pnpm resolves
 * at runtime through `node_modules` symlinks into a `package.json` `exports`
 * map that points at a `dist/` build output frequently absent in a freshly
 * cloned, unbuilt monorepo (and excluded from the index even when present).
 * See docs/plans/2026-07-02-followups.md item 2 and the live
 * Stable_Management/Vega evidence in the accompanying commit message.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScipDatabase } from '../../src/storage/db.js';
import type { ScipQueryConfig } from '../../src/domain/types.js';
import { discoverWorkspacePackages, parsePnpmWorkspacePackagesField } from '../../src/platform/workspace-packages.js';
import { resolveJavaScriptImportPath } from '../../src/source/import-path-resolver.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../fixtures/evidence-fixture.js';

function withWorkspaceFixture(
  files: Record<string, readonly string[] | string>,
  run: (db: ScipDatabase, projectRoot: string) => void,
): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-workspace-pkg-'));
  const projectRoot = join(tempDir, 'project');
  const dbPath = join(tempDir, 'index.db');
  try {
    writeFixtureFiles(projectRoot, files);
    evidenceFixtureDb(dbPath).document(1, 'typescript', 'apps/web/src/consumer.ts').write();

    const config: ScipQueryConfig = { projectRoot, dbPath, indexPath: join(tempDir, 'index.scip') };
    const db = new ScipDatabase(config);
    try {
      run(db, projectRoot);
    } finally {
      db.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const PNPM_WORKSPACE_FILES = {
  'pnpm-workspace.yaml': ['packages:', '  - "apps/*"', '  - "packages/*"', ''].join('\n'),
  'package.json': JSON.stringify({ name: 'fixture-root', private: true }),
  'packages/shared/package.json': JSON.stringify({
    name: '@fixture/shared',
    main: './dist/index.js',
    exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './contracts': { types: './dist/contracts/index.d.ts', import: './dist/contracts/index.js' },
    },
  }),
  // The exports map points at a barrel; the real definition lives one hop
  // further in a sibling file the barrel re-exports — mirrors Vega's
  // `packages/shared/src/contracts/index.ts` -> `./ai-settings.js` shape.
  'packages/shared/src/contracts/index.ts': "export * from './ai-settings.js';\n",
  'packages/shared/src/contracts/ai-settings.ts': 'export interface SharedAuthType {\n  provider: string;\n}\n',
  'apps/web/package.json': JSON.stringify({
    name: '@fixture/web',
    dependencies: { '@fixture/shared': 'workspace:*' },
  }),
  'apps/web/src/consumer.ts': [
    "import type { SharedAuthType } from '@fixture/shared/contracts';",
    'export function describe(value: SharedAuthType): string {',
    '  return value.provider;',
    '}',
    '',
  ].join('\n'),
};

describe('resolveJavaScriptImportPath — pnpm workspace packages', () => {
  it('resolves a workspace-package subpath specifier through its unbuilt dist->src exports mapping', () => {
    withWorkspaceFixture(PNPM_WORKSPACE_FILES, (db, projectRoot) => {
      // Simulate the real pnpm-style symlinked node_modules layout — not
      // read by the resolver (workspace packages resolve from
      // pnpm-workspace.yaml, not node_modules), but this is the actual
      // on-disk shape a pnpm install produces and the fixture should look
      // like it, matching the plan's "simulate a minimal pnpm-style
      // workspace with symlinked package" requirement.
      mkdirSync(join(projectRoot, 'apps/web/node_modules/@fixture'), { recursive: true });
      symlinkSync(join(projectRoot, 'packages/shared'), join(projectRoot, 'apps/web/node_modules/@fixture/shared'));

      const resolved = resolveJavaScriptImportPath(db, 'apps/web/src/consumer.ts', '@fixture/shared/contracts');
      // No `dist/` build output exists in this fixture (pnpm install ran,
      // build did not) — resolution must fall through the dist->src
      // rewrite to the actual indexed source barrel, not fail because the
      // exports target is missing on disk.
      expect(resolved).toBe('packages/shared/src/contracts/index.ts');
    });
  });

  it('resolves the package root specifier (no subpath) via the "." exports entry', () => {
    withWorkspaceFixture(
      {
        'pnpm-workspace.yaml': PNPM_WORKSPACE_FILES['pnpm-workspace.yaml'],
        'package.json': PNPM_WORKSPACE_FILES['package.json'],
        'packages/shared/package.json': PNPM_WORKSPACE_FILES['packages/shared/package.json'],
        'packages/shared/src/index.ts': "export const VERSION = '1.0.0';\n",
        'apps/web/src/consumer.ts': "import { VERSION } from '@fixture/shared';\n",
      },
      (db) => {
        const resolved = resolveJavaScriptImportPath(db, 'apps/web/src/consumer.ts', '@fixture/shared');
        expect(resolved).toBe('packages/shared/src/index.ts');
      },
    );
  });

  it('falls back to a conventional src/<subpath> guess when the package declares no matching exports entry', () => {
    withWorkspaceFixture(
      {
        'pnpm-workspace.yaml': PNPM_WORKSPACE_FILES['pnpm-workspace.yaml'],
        'package.json': PNPM_WORKSPACE_FILES['package.json'],
        'packages/shared/package.json': JSON.stringify({ name: '@fixture/shared' }),
        'packages/shared/src/schemas/index.ts': 'export const schema = {};\n',
        'apps/web/src/consumer.ts': "import { schema } from '@fixture/shared/schemas';\n",
      },
      (db) => {
        const resolved = resolveJavaScriptImportPath(db, 'apps/web/src/consumer.ts', '@fixture/shared/schemas');
        expect(resolved).toBe('packages/shared/src/schemas/index.ts');
      },
    );
  });

  it('returns null for a real external npm package that happens to share a workspace-adjacent scope', () => {
    withWorkspaceFixture(
      {
        'pnpm-workspace.yaml': PNPM_WORKSPACE_FILES['pnpm-workspace.yaml'],
        'package.json': PNPM_WORKSPACE_FILES['package.json'],
        'packages/shared/package.json': PNPM_WORKSPACE_FILES['packages/shared/package.json'],
        'apps/web/src/consumer.ts': "import { z } from 'zod';\n",
      },
      (db) => {
        const resolved = resolveJavaScriptImportPath(db, 'apps/web/src/consumer.ts', 'zod');
        expect(resolved).toBeNull();
      },
    );
  });
});

describe('discoverWorkspacePackages', () => {
  it("discovers packages from pnpm-workspace.yaml globs and reads each one's name + exports", () => {
    withWorkspaceFixture(PNPM_WORKSPACE_FILES, (_db, projectRoot) => {
      const packages = discoverWorkspacePackages(projectRoot);
      const names = packages.map((p) => p.name).sort();
      expect(names).toEqual(['@fixture/shared', '@fixture/web']);
      const shared = packages.find((p) => p.name === '@fixture/shared');
      expect(shared?.relativeDir).toBe('packages/shared');
      expect(shared?.exports).toMatchObject({ '.': { import: './dist/index.js' } });
    });
  });
});

describe('parsePnpmWorkspacePackagesField', () => {
  it('reads a flat glob list under the packages: key, ignoring comments and blank lines', () => {
    const yaml = [
      '# comment before',
      'packages:',
      '  - "apps/*"  # inline comment',
      "  - 'packages/*'",
      '',
      '  - tools/scip-query',
      'nodeLinker: hoisted',
    ].join('\n');
    expect(parsePnpmWorkspacePackagesField(yaml)).toEqual(['apps/*', 'packages/*', 'tools/scip-query']);
  });

  it('returns an empty list when there is no packages: key', () => {
    expect(parsePnpmWorkspacePackagesField('nodeLinker: hoisted\n')).toEqual([]);
  });
});
