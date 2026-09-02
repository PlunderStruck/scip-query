import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTypeScriptSourceFiles } from '../../../src/semantic/typescript/source-file-resolver.js';
import type { ProjectChangeManifest, ProjectFileChange } from '../../../src/domain/project-input.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import {
  TypeScriptSemanticHost,
  planTypeScriptSessionTransition,
} from '../../../src/semantic/typescript/session-host.js';
import {
  createTsMorphProjectBundles,
  loadTsMorph,
  type TsMorphModule,
} from '../../../src/semantic/typescript/ts-morph-runtime.js';
import { evidenceFixtureDb } from '../../fixtures/evidence-fixture.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('persistent TypeScript semantic host', () => {
  it('refreshes ordinary source changes but replaces configuration or uncertain sessions', () => {
    expect(
      planTypeScriptSessionTransition(
        manifest([
          change('added', 'src/added.ts', 'source'),
          change('modified', 'src/changed.ts', 'source'),
          change('deleted', 'src/deleted.ts', 'source'),
        ]),
      ),
    ).toEqual({
      mode: 'refresh',
      addedFiles: ['src/added.ts'],
      modifiedFiles: ['src/changed.ts'],
      deletedFiles: ['src/deleted.ts'],
      reasons: [],
    });
    expect(planTypeScriptSessionTransition(manifest([]))).toEqual({
      mode: 'reuse',
      addedFiles: [],
      modifiedFiles: [],
      deletedFiles: [],
      reasons: [],
    });
    expect(planTypeScriptSessionTransition(manifest([change('modified', 'tsconfig.json', 'config')]))).toEqual(
      expect.objectContaining({ mode: 'replace', reasons: ['config-input-changed'] }),
    );
    expect(
      planTypeScriptSessionTransition({
        ...manifest([]),
        uncertainty: ['prior-snapshot-unavailable'],
      }),
    ).toEqual(expect.objectContaining({ mode: 'replace', reasons: ['prior-snapshot-unavailable'] }));
    expect(planTypeScriptSessionTransition({ ...manifest([]), projectIdentityChanged: true })).toEqual(
      expect.objectContaining({ mode: 'replace', reasons: ['project-identity-changed'] }),
    );
  });

  it('keeps Projects across a source generation and recreates them after config change', () => {
    const fixture = semanticFixture();
    let projectFactoryCalls = 0;
    const host = new TypeScriptSemanticHost(fixture.db, {
      createProjects(module: TsMorphModule, tsconfigPaths: readonly string[]) {
        projectFactoryCalls += 1;
        return createTsMorphProjectBundles(module, tsconfigPaths);
      },
    });

    expect(host.snapshotStats().projectsCreated).toBe(0);
    expect(
      host
        .semanticProvider()
        .importUsage('src/consumer.ts')
        .map((entry) => entry.importedName),
    ).toContain('one');
    expect(projectFactoryCalls).toBe(1);
    expect(host.semanticProvider()).toBe(host.semanticProvider());

    writeFileSync(
      join(fixture.projectRoot, 'src/consumer.ts'),
      "import { two } from './api';\nexport const answer = two;\n",
    );
    const refresh = host.advanceGeneration(fixture.db, manifest([change('modified', 'src/consumer.ts', 'source')]));
    expect(refresh.mode).toBe('refresh');
    expect(
      host
        .semanticProvider()
        .importUsage('src/consumer.ts')
        .map((entry) => entry.importedName),
    ).toContain('two');
    expect(projectFactoryCalls).toBe(1);
    expect(host.snapshotStats()).toEqual(
      expect.objectContaining({
        projectsCreated: 1,
        sessionsRefreshed: 1,
        sessionsReplaced: 0,
      }),
    );

    host.advanceGeneration(fixture.db, manifest([change('modified', 'tsconfig.json', 'config')]));
    expect(host.semanticProvider().availability().available).toBe(true);
    expect(projectFactoryCalls).toBe(2);
    // Bundles are recreated on a config change, but a compiler project is
    // only built when a request needs one of its files.
    expect(host.snapshotStats()).toEqual(
      expect.objectContaining({
        projectsCreated: 1,
        sessionsReplaced: 1,
      }),
    );
    expect(
      host
        .semanticProvider()
        .importUsage('src/consumer.ts')
        .map((entry) => entry.importedName),
    ).toContain('two');
    expect(host.snapshotStats().projectsCreated).toBe(2);
    host.dispose();
    fixture.db.close();
  });

  it('loads only the compiler project whose tsconfig lists the requested file', () => {
    const fixture = semanticFixture();
    mkdirSync(join(fixture.projectRoot, 'packages/b/src'), { recursive: true });
    writeFileSync(
      join(fixture.projectRoot, 'packages/b/tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true }, include: ['src/**/*.ts'] }),
    );
    writeFileSync(join(fixture.projectRoot, 'packages/b/src/b.ts'), 'export const b = 1;\n');
    const tsMorph = loadTsMorph()!;
    const bundles = createTsMorphProjectBundles(tsMorph, [
      join(fixture.projectRoot, 'tsconfig.json'),
      join(fixture.projectRoot, 'packages/b/tsconfig.json'),
    ]);
    expect(bundles.map((bundle) => bundle.loaded)).toEqual([false, false]);
    expect(bundles[1]!.fileNames?.has(join(fixture.projectRoot, 'packages/b/src/b.ts'))).toBe(true);

    const sourceFiles = createTypeScriptSourceFiles(fixture.db, bundles);
    expect(sourceFiles.sourceFile('packages/b/src/b.ts')).not.toBeNull();
    // Only the owning tsconfig's project was built.
    expect(bundles.map((bundle) => bundle.loaded)).toEqual([false, true]);
    expect(sourceFiles.sourceFile('src/consumer.ts')).not.toBeNull();
    expect(bundles.map((bundle) => bundle.loaded)).toEqual([true, true]);
    fixture.db.close();
  });
});

function semanticFixture(): { projectRoot: string; db: ScipDatabase } {
  const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-ts-session-host-'));
  tempDirs.push(projectRoot);
  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  writeFileSync(
    join(projectRoot, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { module: 'ESNext', moduleResolution: 'Node', strict: true },
      include: ['src/**/*.ts'],
    }),
  );
  writeFileSync(join(projectRoot, 'src/api.ts'), 'export const one = 1;\nexport const two = 2;\n');
  writeFileSync(join(projectRoot, 'src/consumer.ts'), "import { one } from './api';\nexport const answer = one;\n");
  const dbPath = join(projectRoot, 'index.db');
  evidenceFixtureDb(dbPath)
    .document(1, 'typescript', 'src/api.ts')
    .document(2, 'typescript', 'src/consumer.ts')
    .chunk(1, 1, 0, 1)
    .chunk(2, 2, 0, 1)
    .write();
  return {
    projectRoot,
    db: new ScipDatabase({ projectRoot, dbPath, indexPath: join(projectRoot, 'index.scip') }),
  };
}

function manifest(changes: ProjectFileChange[]): ProjectChangeManifest {
  return { version: 1, changes, projectIdentityChanged: false, uncertainty: [] };
}

function change(
  kind: ProjectFileChange['kind'],
  path: string,
  inputKind: ProjectFileChange['inputKind'],
): ProjectFileChange {
  const fingerprint = { path, size: 1, hash: 'hash' };
  if (kind === 'added') return { kind, path, inputKind, after: fingerprint };
  if (kind === 'deleted') return { kind, path, inputKind, before: fingerprint };
  return { kind, path, inputKind, before: fingerprint, after: { ...fingerprint, hash: 'hash-v2' } };
}
