import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';
import { reactComponentDuplicates } from '../../../src/queries/frontend/react-component-duplicates.js';
import { vueComponentDuplicates } from '../../../src/queries/frontend/vue-component-duplicates.js';

function withFiles(files: Record<string, string>, run: (db: ScipDatabase) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'scip-frontend-contract-'));
  try {
    writeFixtureFiles(root, files);
    const builder = evidenceFixtureDb(join(root, 'index.db'));
    Object.keys(files).forEach((file, index) =>
      builder.document(index + 1, file.endsWith('.vue') ? 'vue' : 'typescript', file),
    );
    builder.write();
    const db = new ScipDatabase({ projectRoot: root, dbPath: join(root, 'index.db') });
    try {
      run(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const attributes = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${prefix}${i}="value"`).join(' ');

describe('frontend command output contracts', () => {
  it.each(['react', 'vue'] as const)('accounts for all differing %s tokens after the twenty-fifth', (framework) => {
    const template = (unique: string) => `<Widget ${attributes('shared', 8)} ${attributes(unique, 32)} />`;
    const files =
      framework === 'react'
        ? {
            'src/a.tsx': `export function Alpha() { return ${template('left')}; }`,
            'src/b.tsx': `export function Beta() { return ${template('right')}; }`,
          }
        : {
            'src/a.vue': `<template>${template('left')}</template>`,
            'src/b.vue': `<template>${template('right')}</template>`,
          };
    withFiles(files, (db) => {
      const results =
        framework === 'react'
          ? reactComponentDuplicates(db, { minSimilarity: 0 })
          : vueComponentDuplicates(db, { minSimilarity: 0 });
      expect(results).toHaveLength(1);
      const row = results[0]!;
      expect(row.uniqueToA.length).toBeGreaterThan(25);
      expect(row.tokenCountA).toBe(row.sharedTokens.length + row.uniqueToA.length);
      expect(row.tokenCountB).toBe(row.sharedTokens.length + row.uniqueToB.length);
      expect(row.similarity).toBeCloseTo(
        row.sharedTokens.length / (row.sharedTokens.length + row.uniqueToA.length + row.uniqueToB.length),
      );
    });
  });

  it('compares every component in a selected file', () => {
    const shared = `<Widget ${attributes('shared', 8)} />`;
    withFiles(
      {
        'src/selected.tsx': `export function Alpha() { return <Different ${attributes('other', 8)} />; }\nexport function Beta() { return ${shared}; }`,
        'src/peer.tsx': `export function Peer() { return ${shared}; }`,
      },
      (db) => {
        expect(reactComponentDuplicates(db, { filePattern: 'src/selected.tsx' })).toEqual([
          expect.objectContaining({ componentA: 'Beta', componentB: 'Peer', similarity: 1 }),
        ]);
        expect(reactComponentDuplicates(db, { filePattern: 'missing.tsx' })).toEqual([]);
      },
    );
  });
});
