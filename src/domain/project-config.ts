import type { ProjectConfig } from './config-types.js';
import { isRecordObject } from './record-validation.js';

export const LEGACY_PROJECT_CONFIG_SCHEMA_VERSION = 1;
export const CURRENT_PROJECT_CONFIG_SCHEMA_VERSION = 2;
export const PROJECT_CONFIG_SCHEMA_PATH = './node_modules/scip-query/docs/schemas/project-config.schema.json';

export interface CurrentProjectConfig extends ProjectConfig {
  $schema: string;
  schemaVersion: typeof CURRENT_PROJECT_CONFIG_SCHEMA_VERSION;
}

interface AcceptedProjectConfig {
  config: CurrentProjectConfig;
  needsMigration: boolean;
}

// scip-query: ignore-stale -- Discriminated decode result preserves supported, legacy, and invalid config states.
export type DecodedProjectConfig =
  | ({ kind: 'legacy'; sourceVersion: typeof LEGACY_PROJECT_CONFIG_SCHEMA_VERSION } & AcceptedProjectConfig)
  | ({ kind: 'supported'; sourceVersion: typeof CURRENT_PROJECT_CONFIG_SCHEMA_VERSION } & AcceptedProjectConfig)
  | { kind: 'unsupported'; schemaVersion: number; direction: 'older' | 'future' }
  | { kind: 'malformed'; reason: string };

/**
 * Classifies persisted project policy before runtime code interprets any
 * option. Unversioned and explicit-v1 records share the readable legacy
 * meaning; every accepted result carries current in-memory metadata while
 * retaining unknown fields for later conflict-aware writes.
 */
export function decodeProjectConfig(input: unknown): DecodedProjectConfig {
  let value: unknown = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { kind: 'malformed', reason: `invalid JSON: ${reason}` };
    }
  }
  if (!isRecordObject(value)) return { kind: 'malformed', reason: 'project config must be a JSON object' };

  const rawVersion = value['schemaVersion'];
  if (rawVersion !== undefined && !Number.isInteger(rawVersion)) {
    return { kind: 'malformed', reason: 'schemaVersion must be an integer' };
  }
  const schemaVersion = rawVersion === undefined ? LEGACY_PROJECT_CONFIG_SCHEMA_VERSION : (rawVersion as number);
  if (
    schemaVersion !== LEGACY_PROJECT_CONFIG_SCHEMA_VERSION &&
    schemaVersion !== CURRENT_PROJECT_CONFIG_SCHEMA_VERSION
  ) {
    return {
      kind: 'unsupported',
      schemaVersion,
      direction: schemaVersion < LEGACY_PROJECT_CONFIG_SCHEMA_VERSION ? 'older' : 'future',
    };
  }
  const schemaHint = value['$schema'];
  if (schemaHint !== undefined && (typeof schemaHint !== 'string' || schemaHint.trim() === '')) {
    return { kind: 'malformed', reason: '$schema must be a non-empty string when present' };
  }

  const config = currentProjectConfig(value);
  const needsMigration =
    schemaVersion !== CURRENT_PROJECT_CONFIG_SCHEMA_VERSION || typeof value['$schema'] !== 'string';
  return schemaVersion === LEGACY_PROJECT_CONFIG_SCHEMA_VERSION
    ? { kind: 'legacy', sourceVersion: LEGACY_PROJECT_CONFIG_SCHEMA_VERSION, config, needsMigration }
    : { kind: 'supported', sourceVersion: CURRENT_PROJECT_CONFIG_SCHEMA_VERSION, config, needsMigration };
}

// scip-query: ignore-wrapper — this is the schema migration boundary that preserves fields while replacing version metadata.
export function currentProjectConfig(config: ProjectConfig | Record<string, unknown>): CurrentProjectConfig {
  const source = config as Record<string, unknown>;
  const { $schema, schemaVersion: _schemaVersion, ...fields } = source;
  return {
    $schema: typeof $schema === 'string' && $schema.trim() !== '' ? $schema : PROJECT_CONFIG_SCHEMA_PATH,
    schemaVersion: CURRENT_PROJECT_CONFIG_SCHEMA_VERSION,
    ...fields,
  } as CurrentProjectConfig;
}

// scip-query: ignore-wrapper — persisted config bytes require canonical schema metadata, indentation, and terminal newline.
export function serializeCurrentProjectConfig(config: ProjectConfig | Record<string, unknown>): string {
  return `${JSON.stringify(currentProjectConfig(config), null, 2)}\n`;
}
