import { expect, test } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IndexerHistoryFixture } from '../properties/indexer-history-fixture.js';
import {
  publishedTypeScriptIndexGeneration,
  type TypeScriptIndexDocumentRequest,
} from '../../src/reindex/typescript-index-protocol.js';
import { readTypeScriptOverlay } from '../../src/reindex/typescript-overlay-store.js';
import { readPublishedTypeScriptCheckpoint } from '../../src/reindex/typescript-checkpoint.js';

test('recovery rejects unreported source changes, membership, configuration and project mismatches', async () => {
  const fixture = new IndexerHistoryFixture();
  try {
    await fixture.index({ skipIfUnchanged: false, allowExpensiveRebuild: true });
    fixture.startService();
    fixture.write('owner.ts', 'export function value(input: number) { return input + 2; }\n');
    await fixture.index({ allowExpensiveRebuild: false });
    await fixture.stopService();
    const dbPath = join(fixture.cache, 'index.db');
    const generation = fixture.publication()?.publication?.typescriptOverlayGeneration;
    expect(generation).toBeTruthy();
    const overlay = readTypeScriptOverlay(fixture.cache, generation!)!;
    const baseGeneration = publishedTypeScriptIndexGeneration(dbPath)!;
    const request: TypeScriptIndexDocumentRequest = {
      kind: 'emit-documents',
      tsconfigPath: 'tsconfig.json',
      projectArgument: '.',
      projectIdentity: overlay.projectIdentity,
      producerIdentity: overlay.producerIdentity,
      modifiedFiles: ['owner.ts'],
      removedFiles: [],
      affectedFiles: ['owner.ts', 'bridge.ts', 'consumer.ts'],
    };
    const read = (override: Partial<TypeScriptIndexDocumentRequest> = {}, base = baseGeneration) =>
      readPublishedTypeScriptCheckpoint({
        projectRoot: fixture.root,
        dbPath,
        baseGeneration: base,
        request: { ...request, ...override },
      });
    fixture.write('owner.ts', 'export function value(input: number) { return input + 3; }\n');
    const valid = read();
    expect(valid?.sources.get('owner.ts')).toContain('input + 2');
    expect(valid?.documents.lookup('consumer.ts')?.read().byteLength).toBeGreaterThan(0);
    expect(read({}, 'wrong-generation')).toBeNull();
    expect(read({ projectIdentity: 'wrong-project' })).toBeNull();
    expect(read({ producerIdentity: 'wrong-producer' })).toBeNull();
    expect(read({ tsconfigPath: 'other.json' })).toBeNull();
    expect(read({ removedFiles: ['bridge.ts'] })).toBeNull();
    const quiet = fixture.sources.get('quiet.ts')!;
    fixture.write('quiet.ts', quiet + 'export const added = 1;\n');
    expect(read()).toBeNull();
    fixture.write('quiet.ts', quiet);
    fixture.write('new.ts', 'export const added = 1;\n');
    expect(read()).toBeNull();
    fixture.write('new.ts', null);
    const config = readFileSync(join(fixture.root, 'tsconfig.json'), 'utf8');
    writeFileSync(join(fixture.root, 'tsconfig.json'), config.replace('"strict":true', '"strict":false'));
    expect(read()).toBeNull();
    writeFileSync(join(fixture.root, 'tsconfig.json'), config);
    expect(read()).not.toBeNull();
  } finally {
    await fixture.dispose();
  }
}, 60_000);
