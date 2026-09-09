import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { refreshSqliteGenerationMetadata } from '../../src/reindex/sqlite-generation-store.js';
import { IndexerHistoryFixture } from '../properties/indexer-history-fixture.js';

it.each([undefined, 1, 2, 3])(
  'rebuilds an unchanged local index with legacy TypeScript producer %s',
  async (legacyVersion) => {
    const fixture = new IndexerHistoryFixture();
    try {
      await fixture.index();
      const metaPath = join(fixture.cache, 'meta.json');
      const metadata = JSON.parse(readFileSync(metaPath, 'utf8'));
      assert.equal(metadata.fingerprint.typescriptSymbolIdentityVersion, 4);
      assert.equal(metadata.languageFingerprints.typescript.typescriptSymbolIdentityVersion, 4);
      metadata.fingerprint.typescriptSymbolIdentityVersion = legacyVersion;
      metadata.languageFingerprints.typescript.typescriptSymbolIdentityVersion = legacyVersion;
      writeFileSync(metaPath, JSON.stringify(metadata));
      refreshSqliteGenerationMetadata(join(fixture.cache, 'index.db'), metaPath);

      const rebuilt = await fixture.index();
      assert.equal(rebuilt.reused, false, fixture.statuses.join('\n'));
      assert.equal(fixture.publication()?.publication?.mode, 'full');
      fixture.assertCurrent();
      const reused = await fixture.index();
      assert.equal(reused.reused, true, fixture.statuses.join('\n'));
    } finally {
      await fixture.dispose();
    }
  },
  120_000,
);
