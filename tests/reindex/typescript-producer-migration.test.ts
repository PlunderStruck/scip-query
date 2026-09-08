import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { refreshSqliteGenerationMetadata } from '../../src/reindex/sqlite-generation-store.js';
import { IndexerHistoryFixture } from '../properties/indexer-history-fixture.js';

it('rebuilds a complete unchanged local index whose TypeScript producer identity predates the adapter', async () => {
  const fixture = new IndexerHistoryFixture();
  try {
    await fixture.index();
    const metaPath = join(fixture.cache, 'meta.json');
    const metadata = JSON.parse(readFileSync(metaPath, 'utf8'));
    assert.equal(metadata.fingerprint.typescriptSymbolIdentityVersion, 1);
    assert.equal(metadata.languageFingerprints.typescript.typescriptSymbolIdentityVersion, 1);
    delete metadata.fingerprint.typescriptSymbolIdentityVersion;
    delete metadata.languageFingerprints.typescript.typescriptSymbolIdentityVersion;
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
}, 120_000);
