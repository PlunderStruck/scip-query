import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CURRENT_PROJECT_CONFIG_SCHEMA_VERSION,
  decodeProjectConfig,
  LEGACY_PROJECT_CONFIG_SCHEMA_VERSION,
  PROJECT_CONFIG_SCHEMA_PATH,
  serializeCurrentProjectConfig,
} from '../../src/domain/project-config.js';

describe('project config format', () => {
  it('migrates unversioned and explicit-v1 records without dropping unknown fields', () => {
    for (const input of [
      { languages: ['typescript'], futureOption: { retained: true } },
      { schemaVersion: LEGACY_PROJECT_CONFIG_SCHEMA_VERSION, languages: ['typescript'], futureOption: 42 },
    ]) {
      const decoded = decodeProjectConfig(input);

      expect(decoded).toMatchObject({
        kind: 'legacy',
        sourceVersion: LEGACY_PROJECT_CONFIG_SCHEMA_VERSION,
        needsMigration: true,
        config: {
          $schema: PROJECT_CONFIG_SCHEMA_PATH,
          schemaVersion: CURRENT_PROJECT_CONFIG_SCHEMA_VERSION,
          languages: ['typescript'],
          futureOption: input.futureOption,
        },
      });
    }
  });

  it('accepts current records and marks a missing editor schema for the next authorized write', () => {
    expect(
      decodeProjectConfig({
        $schema: PROJECT_CONFIG_SCHEMA_PATH,
        schemaVersion: CURRENT_PROJECT_CONFIG_SCHEMA_VERSION,
        watch: { enabled: true },
      }),
    ).toMatchObject({ kind: 'supported', needsMigration: false });

    expect(
      decodeProjectConfig({
        schemaVersion: CURRENT_PROJECT_CONFIG_SCHEMA_VERSION,
        watch: { enabled: true },
      }),
    ).toMatchObject({
      kind: 'supported',
      needsMigration: true,
      config: { $schema: PROJECT_CONFIG_SCHEMA_PATH },
    });
  });

  it('distinguishes unsupported older and future versions', () => {
    expect(decodeProjectConfig({ schemaVersion: 0 })).toEqual({
      kind: 'unsupported',
      schemaVersion: 0,
      direction: 'older',
    });
    expect(decodeProjectConfig({ schemaVersion: 3 })).toEqual({
      kind: 'unsupported',
      schemaVersion: 3,
      direction: 'future',
    });
  });

  it('rejects invalid JSON, non-objects, malformed versions, and invalid schema hints', () => {
    for (const input of [
      '{broken',
      [],
      null,
      { schemaVersion: '2' },
      { schemaVersion: 2.5 },
      { schemaVersion: 2, $schema: '' },
      { schemaVersion: 2, $schema: 42 },
    ]) {
      expect(decodeProjectConfig(input)).toMatchObject({ kind: 'malformed' });
    }
  });

  it('serializes canonical metadata first and preserves custom schema hints and unknown fields', () => {
    const serialized = serializeCurrentProjectConfig({
      futureOption: { retained: true },
      $schema: './custom-project-config.schema.json',
      schemaVersion: CURRENT_PROJECT_CONFIG_SCHEMA_VERSION,
      languages: ['rust'],
    });

    expect(serialized.endsWith('\n')).toBe(true);
    expect(JSON.parse(serialized)).toEqual({
      $schema: './custom-project-config.schema.json',
      schemaVersion: CURRENT_PROJECT_CONFIG_SCHEMA_VERSION,
      futureOption: { retained: true },
      languages: ['rust'],
    });
    expect(serialized.indexOf('"$schema"')).toBeLessThan(serialized.indexOf('"schemaVersion"'));
    expect(serialized.indexOf('"schemaVersion"')).toBeLessThan(serialized.indexOf('"futureOption"'));
  });

  it('keeps the packaged JSON Schema aligned with the runtime discriminator', () => {
    const schema = JSON.parse(readFileSync('docs/schemas/project-config.schema.json', 'utf8')) as {
      properties?: Record<string, { const?: unknown; type?: unknown; pattern?: unknown }>;
      required?: string[];
      additionalProperties?: boolean;
    };

    expect(schema.properties?.['schemaVersion']?.const).toBe(CURRENT_PROJECT_CONFIG_SCHEMA_VERSION);
    expect(schema.properties?.['$schema']?.type).toBe('string');
    expect(schema.properties?.['collaborationDomainId']?.pattern).toBe(
      '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-4[a-fA-F0-9]{3}-[89aAbB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}$',
    );
    expect(schema.required).toEqual(['schemaVersion']);
    expect(schema.additionalProperties).toBe(true);
  });
});
