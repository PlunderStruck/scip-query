/**
 * tsconfig `compilerOptions.paths` alias resolution for JS/TS bare
 * specifiers (`@/foo`, `~/bar`). Before this, `resolveJavaScriptImportPath`
 * returned `null` for any specifier that wasn't relative or absolute,
 * treating path aliases the same as unresolvable npm package names. That
 * starved the source-fallback reference-counting layer of evidence for any
 * symbol consumed only through an aliased import — see
 * docs/plans/2026-07-02-followups.md item 1 and the accompanying
 * stale-abstractions-accuracy.test.ts fixture for the end-to-end repro.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScipDatabase } from '../../src/storage/db.js';
import type { ScipQueryConfig } from '../../src/domain/types.js';
import { resolveJavaScriptImportPath } from '../../src/resolution/import-path-resolver.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../fixtures/evidence-fixture.js';

function withAliasFixture(files: Record<string, readonly string[] | string>, run: (db: ScipDatabase) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-import-path-alias-'));
  const projectRoot = join(tempDir, 'project');
  const dbPath = join(tempDir, 'index.db');
  try {
    writeFixtureFiles(projectRoot, files);
    evidenceFixtureDb(dbPath).document(1, 'typescript', 'src/consumer.ts').write();

    const config: ScipQueryConfig = { projectRoot, dbPath, indexPath: join(tempDir, 'index.scip') };
    const db = new ScipDatabase(config);
    try {
      run(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('resolveJavaScriptImportPath — tsconfig path aliases', () => {
  it('resolves a `@/*` alias declared directly in tsconfig.json', () => {
    withAliasFixture(
      {
        'tsconfig.json': JSON.stringify({
          compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } },
        }),
        'src/consumer.ts': "import type { Shape } from '@/lib/shape';\n",
        'src/lib/shape.ts': 'export interface Shape { id: string }\n',
      },
      (db) => {
        const resolved = resolveJavaScriptImportPath(db, 'src/consumer.ts', '@/lib/shape');
        expect(resolved).toBe('src/lib/shape.ts');
      },
    );
  });

  it('skips a solution-style shell tsconfig.json (empty files + references) in favor of a sibling app config with real paths', () => {
    withAliasFixture(
      {
        // Common Vite/vue-tsc scaffold shape: the root config only wires up
        // project references, no compilerOptions of its own.
        'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }] }),
        'tsconfig.app.json': JSON.stringify({
          compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } },
          include: ['src/**/*.ts'],
        }),
        'src/consumer.ts': "import type { Shape } from '@/lib/shape';\n",
        'src/lib/shape.ts': 'export interface Shape { id: string }\n',
      },
      (db) => {
        const resolved = resolveJavaScriptImportPath(db, 'src/consumer.ts', '@/lib/shape');
        expect(resolved).toBe('src/lib/shape.ts');
      },
    );
  });

  it('still returns null for an unresolvable bare specifier (real npm package) when no paths entry matches', () => {
    withAliasFixture(
      {
        'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }),
        'src/consumer.ts': "import { z } from 'zod';\n",
      },
      (db) => {
        const resolved = resolveJavaScriptImportPath(db, 'src/consumer.ts', 'zod');
        expect(resolved).toBeNull();
      },
    );
  });

  it('still returns null for a bare specifier when no tsconfig exists at all', () => {
    withAliasFixture(
      {
        'src/consumer.ts': "import type { Shape } from '@/lib/shape';\n",
        'src/lib/shape.ts': 'export interface Shape { id: string }\n',
      },
      (db) => {
        const resolved = resolveJavaScriptImportPath(db, 'src/consumer.ts', '@/lib/shape');
        expect(resolved).toBeNull();
      },
    );
  });

  it('leaves ordinary relative-specifier resolution unaffected', () => {
    withAliasFixture(
      {
        'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }),
        'src/consumer.ts': "import type { Shape } from './lib/shape.js';\n",
        'src/lib/shape.ts': 'export interface Shape { id: string }\n',
      },
      (db) => {
        const resolved = resolveJavaScriptImportPath(db, 'src/consumer.ts', './lib/shape.js');
        expect(resolved).toBe('src/lib/shape.ts');
      },
    );
  });
});
