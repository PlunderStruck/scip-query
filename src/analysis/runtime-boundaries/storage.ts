import Database from 'better-sqlite3';
import type { ScipDatabase } from '../../storage/db.js';
import type { BoundaryObservation, BoundaryRelationGroup, BoundarySourceScope, RuntimeBoundaryGraph } from './types.js';

const TABLE = 'scip_query_runtime_boundaries';
const OBSERVATIONS_TABLE = 'scip_query_runtime_observations';
const GROUPS_TABLE = 'scip_query_runtime_relation_groups';
const PARTICIPANTS_TABLE = 'scip_query_runtime_relation_participants';

export function writeRuntimeBoundaryGraph(dbPath: string, graph: RuntimeBoundaryGraph): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL,
        extractor_version TEXT NOT NULL,
        payload TEXT NOT NULL
      )
    `);
    createIndexedRuntimeTables(db);
    db.transaction(() => {
      db.prepare(
        `INSERT OR REPLACE INTO ${TABLE} (singleton, schema_version, extractor_version, payload) VALUES (1, ?, ?, ?)`,
      ).run(graph.schemaVersion, graph.extractorVersion, JSON.stringify(graph));
      db.prepare(`DELETE FROM ${OBSERVATIONS_TABLE}`).run();
      db.prepare(`DELETE FROM ${PARTICIPANTS_TABLE}`).run();
      db.prepare(`DELETE FROM ${GROUPS_TABLE}`).run();

      const insertObservation = db.prepare(
        `INSERT INTO ${OBSERVATIONS_TABLE}
         (id, protocol, action, role, strength, source_scope, resolution, file, start_line, end_line, owner_symbol, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const observation of graph.observations) {
        insertObservation.run(
          observation.id,
          observation.protocol,
          observation.action,
          observation.role,
          observation.strength,
          observation.sourceScope,
          observation.resolution,
          observation.source.file,
          observation.source.startLine,
          observation.source.endLine,
          observation.owner.symbol,
          JSON.stringify(observation),
        );
      }

      const insertGroup = db.prepare(
        `INSERT INTO ${GROUPS_TABLE} (id, protocol, join_rule, normalized_key, payload) VALUES (?, ?, ?, ?, ?)`,
      );
      const insertParticipant = db.prepare(
        `INSERT INTO ${PARTICIPANTS_TABLE} (group_id, observation_id, participant_role) VALUES (?, ?, ?)`,
      );
      for (const group of graph.relationGroups) {
        insertGroup.run(group.id, group.protocol, group.joinRule, group.normalizedKey, JSON.stringify(group));
        for (const observationId of group.producerIds) insertParticipant.run(group.id, observationId, 'producer');
        for (const observationId of group.consumerIds) insertParticipant.run(group.id, observationId, 'consumer');
        for (const observationId of group.declarationIds) insertParticipant.run(group.id, observationId, 'declaration');
      }
    })();
  } finally {
    db.close();
  }
}

export function readRuntimeBoundaryObservations(
  db: ScipDatabase,
  opts: {
    protocols?: readonly string[];
    actions?: readonly string[];
    sourceScopes?: readonly BoundarySourceScope[];
    files?: readonly string[];
  } = {},
): BoundaryObservation[] {
  if (!tableExists(db, OBSERVATIONS_TABLE)) return readRuntimeBoundaryGraph(db)?.observations ?? [];
  const clauses: string[] = [];
  const values: string[] = [];
  addInClause(clauses, values, 'protocol', opts.protocols);
  addInClause(clauses, values, 'action', opts.actions);
  addInClause(clauses, values, 'source_scope', opts.sourceScopes);
  addInClause(clauses, values, 'file', opts.files);
  const rows = db.all<{ payload: string }>(
    `SELECT payload FROM ${OBSERVATIONS_TABLE}${clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY file, start_line, id`,
    ...values,
  );
  return rows.flatMap((row) => parsePayload<BoundaryObservation>(row.payload));
}

export function readRuntimeBoundaryRelationGroups(
  db: ScipDatabase,
  opts: { protocols?: readonly string[]; joinRules?: readonly string[] } = {},
): BoundaryRelationGroup[] {
  if (!tableExists(db, GROUPS_TABLE)) return readRuntimeBoundaryGraph(db)?.relationGroups ?? [];
  const clauses: string[] = [];
  const values: string[] = [];
  addInClause(clauses, values, 'protocol', opts.protocols);
  addInClause(clauses, values, 'join_rule', opts.joinRules);
  const rows = db.all<{ payload: string }>(
    `SELECT payload FROM ${GROUPS_TABLE}${clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY protocol, normalized_key, id`,
    ...values,
  );
  return rows.flatMap((row) => parsePayload<BoundaryRelationGroup>(row.payload));
}

function createIndexedRuntimeTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${OBSERVATIONS_TABLE} (
      id TEXT PRIMARY KEY,
      protocol TEXT NOT NULL,
      action TEXT NOT NULL,
      role TEXT NOT NULL,
      strength TEXT NOT NULL,
      source_scope TEXT NOT NULL,
      resolution TEXT NOT NULL,
      file TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      owner_symbol TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_observations_protocol_action_scope
      ON ${OBSERVATIONS_TABLE}(protocol, action, source_scope);
    CREATE INDEX IF NOT EXISTS idx_runtime_observations_file_line
      ON ${OBSERVATIONS_TABLE}(file, start_line);

    CREATE TABLE IF NOT EXISTS ${GROUPS_TABLE} (
      id TEXT PRIMARY KEY,
      protocol TEXT NOT NULL,
      join_rule TEXT NOT NULL,
      normalized_key TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_groups_protocol_key
      ON ${GROUPS_TABLE}(protocol, join_rule, normalized_key);

    CREATE TABLE IF NOT EXISTS ${PARTICIPANTS_TABLE} (
      group_id TEXT NOT NULL,
      observation_id TEXT NOT NULL,
      participant_role TEXT NOT NULL,
      PRIMARY KEY (group_id, observation_id, participant_role)
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_participants_observation
      ON ${PARTICIPANTS_TABLE}(observation_id, participant_role);
  `);
}

function tableExists(db: ScipDatabase, name: string): boolean {
  return Boolean(db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name));
}

function addInClause(
  clauses: string[],
  values: string[],
  column: string,
  requested: readonly string[] | undefined,
): void {
  if (!requested || requested.length === 0) return;
  clauses.push(`${column} IN (${requested.map(() => '?').join(', ')})`);
  values.push(...requested);
}

function parsePayload<T>(payload: string): T[] {
  try {
    return [JSON.parse(payload) as T];
  } catch {
    return [];
  }
}

export function readRuntimeBoundaryGraph(db: ScipDatabase): RuntimeBoundaryGraph | null {
  const table = db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", TABLE);
  if (!table) return null;
  const row = db.get<{ schema_version: number; payload: string }>(
    `SELECT schema_version, payload FROM ${TABLE} WHERE singleton = 1`,
  );
  if (!row || row.schema_version !== 2) return null;
  try {
    const graph = JSON.parse(row.payload) as RuntimeBoundaryGraph;
    return graph.schemaVersion === 2 &&
      Array.isArray(graph.observations) &&
      Array.isArray(graph.relationGroups) &&
      Array.isArray(graph.links)
      ? graph
      : null;
  } catch {
    return null;
  }
}
