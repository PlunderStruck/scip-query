import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFixture, openFixtureDatabase, readValueFromDatabase } from '../fixtures/sqlite-generation.js';
import {
  publishSqliteAugmentation,
  ensureImmutableSqliteGeneration,
  inspectSqliteGeneration,
  readSqliteGenerationState,
} from '../../src/reindex/sqlite-generation-store.js';

describe('standalone augmentation publication', () => {
  it('keeps existing readers stable and publishes the complete augmented database for new readers', async () => {
    const fixture = createFixture();
    const { outputDb, outputScip, metaPath } = fixture.paths;
    ensureImmutableSqliteGeneration(outputDb, outputScip, metaPath);
    const before = readSqliteGenerationState(outputDb)!;
    const reader = openFixtureDatabase(fixture);
    try {
      await publishSqliteAugmentation(outputDb, (candidate) => {
        const db = new Database(candidate);
        try {
          db.exec("UPDATE generation_value SET value = 'augmented'");
        } finally {
          db.close();
        }
        expect(readSqliteGenerationState(outputDb)).toEqual(before);
        expect(readValueFromDatabase(reader.db)).toBe('old');
      });
      const current = openFixtureDatabase(fixture);
      try {
        expect(readValueFromDatabase(current.db)).toBe('augmented');
        expect(readValueFromDatabase(reader.db)).toBe('old');
        expect(current.generation.identity).not.toBe(before.currentGeneration);
        expect(inspectSqliteGeneration(outputDb, metaPath).state).toBe('current');
      } finally {
        current.close();
      }
    } finally {
      reader.close();
    }
  });

  it('discards partial augmentation when a later provider step fails', async () => {
    const fixture = createFixture();
    const { outputDb, outputScip, metaPath } = fixture.paths;
    ensureImmutableSqliteGeneration(outputDb, outputScip, metaPath);
    const before = readSqliteGenerationState(outputDb);
    const bytes = readFileSync(outputDb);
    await expect(
      publishSqliteAugmentation(outputDb, (candidate) => {
        const db = new Database(candidate);
        try {
          db.exec("UPDATE generation_value SET value = 'partial'");
        } finally {
          db.close();
        }
        throw new Error('provider unavailable');
      }),
    ).rejects.toThrow('provider unavailable');
    expect(readSqliteGenerationState(outputDb)).toEqual(before);
    expect(readFileSync(outputDb)).toEqual(bytes);
    expect(readdirSync(dirname(outputDb)).filter((path) => path.includes('.augment-'))).toEqual([]);
  });
});
