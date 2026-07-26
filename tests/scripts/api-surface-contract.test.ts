import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildApiSurface,
  checkApiContract,
  classifySignatureChange,
  compareApiSurfaces,
  createApiManifest,
  digestApiSurface,
  normalizeDeclarationText,
  updateApiContract,
} from '../../scripts/api-surface-contract.mjs';

describe('public API declaration contract', () => {
  it('keeps the committed manifest and acceptance record aligned with package exports', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'docs/api/scip-query.api.json'), 'utf8'));
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    const declaredPaths = Object.entries(packageJson.exports)
      .filter(([, target]) => typeof target === 'object' && target !== null && 'types' in target)
      .map(([path]) => path)
      .sort();
    expect(Object.keys(manifest.surface.entries).sort()).toEqual(declaredPaths);
    expect(manifest.digest).toBe(digestApiSurface(manifest.surface));
    const exports = Object.values(manifest.surface.entries).flatMap(
      (entry) => (entry as { exports: Array<{ signature: string }> }).exports,
    );
    expect(exports).not.toContainEqual(expect.objectContaining({ signature: expect.stringMatching(/^unresolved /) }));
    const acceptance = JSON.parse(
      readFileSync(join(process.cwd(), `docs/api/changes/${manifest.digest.slice(0, 16)}.json`), 'utf8'),
    );
    expect(acceptance).toMatchObject({
      kind: 'scip-query-api-acceptance',
      schemaVersion: 1,
      baselineDigest: manifest.digest,
    });
  });

  it('normalizes comments, whitespace, hashed chunks, and named export order', () => {
    const left = `
      // irrelevant
      import { B, A } from './shared-ABCDEFGH.js';
      export { B, type A };
    `;
    const right = `import { A, B } from "./shared-ZYXWVUTS.js";\nexport { type A, B };`;
    expect(normalizeDeclarationText(left)).toBe(normalizeDeclarationText(right));
  });

  it('classifies export addition as additive and removal as breaking', () => {
    const before = surface('export declare function one(): string;\nexport { one };');
    const after = surface(
      'export declare function one(): string;\nexport declare function two(): string;\nexport { one, two };',
    );
    expect(compareApiSurfaces(before, after).classification).toBe('additive');
    expect(compareApiSurfaces(after, before).classification).toBe('breaking');
  });

  it('classifies an optional interface field addition as additive', () => {
    const before = 'export interface Result { value: string; }';
    const after = 'export interface Result { value: string; note?: string; }';
    expect(classifySignatureChange(before, after)).toBe('additive');
  });

  it.each([
    [
      'required optional parameter',
      'export declare function query(value?: string): void;',
      'export declare function query(value: string): void;',
    ],
    ['narrowed union', "export type Mode = 'a' | 'b';", "export type Mode = 'a';"],
    ['widened union with unknown variance', "export type Mode = 'a';", "export type Mode = 'a' | 'b';"],
    [
      'required interface field',
      'export interface Result { value: string; }',
      'export interface Result { value: string; id: string; }',
    ],
  ])('fails conservatively for %s', (_label, before, after) => {
    expect(classifySignatureChange(before, after)).toBe('breaking');
  });

  it('fails when an exported declaration target is missing', () => {
    const root = fixtureRoot();
    writePackage(root, {
      '.': { import: './dist/index.js', types: './dist/missing.d.ts' },
    });
    expect(() => buildApiSurface({ projectRoot: root })).toThrow(/Missing declaration path/);
  });

  it('treats a changed declaration target as breaking even when text is identical', () => {
    const before = surface('declare function query(): string;\nexport { query };');
    const after = structuredClone(before);
    after.entries['.'].types = 'dist/renamed.d.ts';
    expect(compareApiSurfaces(before, after)).toMatchObject({
      classification: 'breaking',
      changes: [expect.objectContaining({ kind: 'declaration-target-changed' })],
    });
  });

  it('resolves kinds and signatures through generated declaration re-exports', () => {
    const root = fixtureRoot();
    writePackage(root, {
      '.': { import: './dist/index.js', types: './dist/index.d.ts' },
    });
    writeDeclaration(root, 'shared.d.ts', 'interface Result { value: string; }\nexport type { Result as R };');
    writeDeclaration(root, 'index.d.ts', "export { type R as Result } from './shared.js';");
    expect(buildApiSurface({ projectRoot: root }).entries['.'].exports).toEqual([
      {
        kind: 'type',
        name: 'Result',
        signature: 'interface Result {\n    value: string;\n}',
      },
    ]);
  });

  it('requires an explicit acceptance record and then passes the unchanged surface', () => {
    const root = fixtureRoot();
    writePackage(root, {
      '.': { import: './dist/index.js', types: './dist/index.d.ts' },
    });
    writeDeclaration(root, 'index.d.ts', 'export declare function query(value?: string): string;\nexport { query };');

    expect(() => checkApiContract({ projectRoot: root })).toThrow(/Missing API manifest/);
    const update = updateApiContract({
      projectRoot: root,
      classification: 'compatible-correction',
      reason: 'Establish the first declaration compatibility baseline.',
      now: () => new Date('2026-07-25T00:00:00.000Z'),
    });
    expect(update.record.baselineDigest).toBe(update.manifest.digest);
    expect(checkApiContract({ projectRoot: root }).diff.changes).toEqual([]);
  });

  it('rejects drift until it is classified and rejects breaking drift as additive', () => {
    const root = fixtureRoot();
    writePackage(root, {
      '.': { import: './dist/index.js', types: './dist/index.d.ts' },
    });
    writeDeclaration(root, 'index.d.ts', 'export declare function query(value?: string): string;\nexport { query };');
    updateApiContract({
      projectRoot: root,
      classification: 'compatible-correction',
      reason: 'Establish the first declaration compatibility baseline.',
    });

    writeDeclaration(root, 'index.d.ts', 'export declare function query(value: string): string;\nexport { query };');
    expect(() => checkApiContract({ projectRoot: root })).toThrow(/Public TypeScript API drift \(breaking\)/);
    expect(() =>
      updateApiContract({
        projectRoot: root,
        classification: 'additive',
        reason: 'Incorrectly claim this breaking change is additive.',
      }),
    ).toThrow(/cannot be accepted as additive/);

    const accepted = updateApiContract({
      projectRoot: root,
      classification: 'breaking',
      reason: 'Require the parameter in the next intentionally breaking release.',
      now: () => new Date('2026-07-25T01:00:00.000Z'),
    });
    expect(JSON.parse(readFileSync(accepted.recordPath, 'utf8'))).toMatchObject({
      classification: 'breaking',
      automaticClassification: 'breaking',
    });
    expect(checkApiContract({ projectRoot: root }).diff.changes).toEqual([]);
  });
});

function surface(declaration: string) {
  const root = fixtureRoot();
  writePackage(root, {
    '.': { import: './dist/index.js', types: './dist/index.d.ts' },
  });
  writeDeclaration(root, 'index.d.ts', declaration);
  return createApiManifest(buildApiSurface({ projectRoot: root })).surface;
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'scip-query-api-contract-'));
  mkdirSync(join(root, 'dist'), { recursive: true });
  return root;
}

function writePackage(root: string, exports: Record<string, unknown>): void {
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-package', version: '1.2.3', type: 'module', exports }),
  );
}

function writeDeclaration(root: string, path: string, declaration: string): void {
  writeFileSync(join(root, 'dist', path), declaration);
}
