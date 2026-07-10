import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import {
  createTypeScriptDocumentEmitter,
  loadTypeScriptDocumentRuntime,
} from '../../src/reindex/typescript-document-emitter.js';
import {
  assembleTypeScriptIndex,
  commitTypeScriptFragmentGeneration,
  pruneTypeScriptFragmentGenerations,
  readTypeScriptFragmentGeneration,
  seedTypeScriptFragmentGeneration,
  typeScriptFragmentStorePaths,
} from '../../src/reindex/typescript-fragment-store.js';

const require = createRequire(import.meta.url);

describe('TypeScript fragment store', () => {
  test('persists, validates, assembles, and prunes exact document generations', () => {
    const availability = loadTypeScriptDocumentRuntime();
    expect(availability.available).toBe(true);
    if (!availability.available) return;

    const root = realpathSync(mkdtempSync(join(tmpdir(), 'scip-query-fragment-store-')));
    const cacheDir = join(root, '.cache');
    writeFixture(root);
    const created = createTypeScriptDocumentEmitter({
      workspaceRoot: root,
      tsconfigPath: 'tsconfig.json',
      projectRoot: '.',
      runtime: availability.runtime,
    });
    expect(created.available).toBe(true);
    if (!created.available) return;

    const initial = created.emitter.initialize();
    const baseline = cleanOracle(root);
    const initialIdentities = new Map(
      initial.fragments.map((fragment) => [fragment.relativePath, `g1:${fragment.relativePath}`]),
    );
    const seeded = seedTypeScriptFragmentGeneration({
      cacheDir,
      runtime: availability.runtime,
      indexBytes: baseline,
      producerIdentity: initial.producerIdentity,
      projectIdentity: 'fixture-project-v1',
      generationIdentity: 'generation-1',
      documentIdentities: initialIdentities,
      now: () => new Date('2026-07-09T00:00:00.000Z'),
    });
    expect(seeded.documents).toHaveLength(2);
    const loadedInitial = readTypeScriptFragmentGeneration({
      cacheDir,
      generationIdentity: 'generation-1',
      producerIdentity: initial.producerIdentity,
      projectIdentity: 'fixture-project-v1',
    });
    expect([...loadedInitial.fragments.keys()]).toEqual(['src/a.ts', 'src/b.ts']);

    writeFileSync(
      join(root, 'src/a.ts'),
      [
        'export interface Shape { point: { x: number; y: number; z: number } }',
        'export const origin: Shape = { point: { x: 0, y: 0, z: 0 } };',
        '',
      ].join('\n'),
    );
    const update = created.emitter.advance({ modifiedFiles: ['src/a.ts'], affectedFiles: ['src/a.ts', 'src/b.ts'] });
    const cleanEdited = cleanOracle(root);
    const nextIdentities = new Map(
      update.fragments.map((fragment) => [fragment.relativePath, `g2:${fragment.relativePath}`]),
    );
    const committed = commitTypeScriptFragmentGeneration({
      cacheDir,
      previousGenerationIdentity: 'generation-1',
      producerIdentity: update.producerIdentity,
      projectIdentity: 'fixture-project-v1',
      generationIdentity: 'generation-2',
      fragments: update.fragments,
      documentIdentities: nextIdentities,
      now: () => new Date('2026-07-09T00:00:01.000Z'),
    });
    expect(committed.documents.map((document) => document.documentIdentity)).toEqual(['g2:src/a.ts', 'g2:src/b.ts']);

    const assembled = assembleTypeScriptIndex({
      runtime: availability.runtime,
      baseIndexBytes: baseline,
      fragments: update.fragments,
    });
    expect(Buffer.from(assembled)).toEqual(cleanEdited);

    expect(() =>
      assembleTypeScriptIndex({
        runtime: availability.runtime,
        baseIndexBytes: baseline,
        fragments: [{ ...update.fragments[0]!, relativePath: 'src/missing.ts' }],
      }),
    ).toThrow('has no prior document');
    expect(() =>
      readTypeScriptFragmentGeneration({
        cacheDir,
        generationIdentity: 'generation-2',
        producerIdentity: update.producerIdentity,
        projectIdentity: 'wrong-project',
      }),
    ).toThrow('project identity changed');
    expect(() =>
      commitTypeScriptFragmentGeneration({
        cacheDir,
        previousGenerationIdentity: 'generation-1',
        producerIdentity: update.producerIdentity,
        projectIdentity: 'fixture-project-v1',
        generationIdentity: 'generation-2',
        fragments: update.fragments,
        documentIdentities: new Map(update.fragments.map((fragment) => [fragment.relativePath, 'different'])),
      }),
    ).toThrow('generation is immutable');

    const paths = typeScriptFragmentStorePaths(cacheDir);
    pruneTypeScriptFragmentGenerations(cacheDir, ['generation-2']);
    expect(readdirSync(paths.generationDir)).toHaveLength(1);
    expect(readdirSync(paths.blobDir).sort()).toEqual(
      committed.documents.map((document) => `${document.blobHash}.scipdoc`).sort(),
    );

    const corrupt = committed.documents[0]!;
    const corruptPath = join(paths.blobDir, `${corrupt.blobHash}.scipdoc`);
    expect(existsSync(corruptPath)).toBe(true);
    writeFileSync(corruptPath, 'corrupt');
    expect(() => readTypeScriptFragmentGeneration({ cacheDir, generationIdentity: 'generation-2' })).toThrow(
      'blob is corrupt',
    );
  });
});

function writeFixture(root: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fragment-fixture', version: '1.0.0' }));
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true },
      include: ['src/**/*.ts'],
    }),
  );
  writeFileSync(
    join(root, 'src/a.ts'),
    [
      'export interface Shape { point: { x: number; y: number } }',
      'export const origin: Shape = { point: { x: 0, y: 0 } };',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'src/b.ts'),
    ["import { origin, type Shape } from './a.js';", 'export const selected: Shape = origin;', ''].join('\n'),
  );
}

function cleanOracle(root: string): Buffer {
  const packagePath = require.resolve('@sourcegraph/scip-typescript/package.json');
  const mainPath = join(dirname(packagePath), 'dist/src/main.js');
  const outputPath = join(root, 'oracle.scip');
  execFileSync(process.execPath, [mainPath, 'index', '--cwd', root, '--output', outputPath, '--no-progress-bar', '.'], {
    cwd: root,
    stdio: 'pipe',
  });
  return readFileSync(outputPath);
}
