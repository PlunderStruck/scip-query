import { expect, test } from 'vitest';
import { createFixture, createCandidateArtifacts, openFixtureDatabase } from '../fixtures/sqlite-generation.js';
import { promoteReindexArtifacts } from '../../src/reindex/sqlite-generation-store.js';
import {
  decodeResultCursor,
  encodeResultCursor,
  indexGenerationIdentity,
} from '../../src/runtime/result-pagination.js';

test('rejects a continuation cursor before applying an old offset to a new result set', () => {
  const fixture = createFixture();
  promoteReindexArtifacts({ ...fixture.paths });
  const firstPageReader = openFixtureDatabase(fixture);
  const cursor = encodeResultCursor({
    command: 'refs',
    target: 'value',
    offset: 1,
    indexGeneration: indexGenerationIdentity(firstPageReader),
  });

  const changed = createCandidateArtifacts(fixture.root, 'changed-order', 'changed-scip', 'changed-meta');
  promoteReindexArtifacts({
    tempOutputScip: changed.scip,
    tempOutputDb: changed.db,
    tempMetaPath: changed.meta,
    outputScip: fixture.paths.outputScip,
    outputDb: fixture.paths.outputDb,
    metaPath: fixture.paths.metaPath,
  });
  const continuationReader = openFixtureDatabase(fixture);
  try {
    expect(
      decodeResultCursor(cursor, {
        command: 'refs',
        target: 'value',
        indexGeneration: indexGenerationIdentity(firstPageReader),
      }).offset,
    ).toBe(1);
    expect(() =>
      decodeResultCursor(cursor, {
        command: 'refs',
        target: 'value',
        indexGeneration: indexGenerationIdentity(continuationReader),
      }),
    ).toThrow('index changed');
  } finally {
    firstPageReader.close();
    continuationReader.close();
  }
});
