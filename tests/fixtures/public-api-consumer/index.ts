import { ProjectIndex, parseSymbol, type ScipDatabase, type ScipQueryConfig } from 'scip-query';
import { refs, type RefResult } from 'scip-query/queries/refs';
import { reindex, type ReindexOptions, type ReindexResult } from 'scip-query/reindex';
import {
  CURRENT_CLI_JSON_ENVELOPE_SCHEMA_VERSION,
  decodeCliJsonEnvelope,
  type DecodedCliJsonEnvelope,
} from 'scip-query/runtime';

declare const database: ScipDatabase;
declare const config: ScipQueryConfig;

const index = new ProjectIndex(database);
const references: RefResult[] = refs(database, 'login');
const options: ReindexOptions = { projectRoot: '.', skipIfUnchanged: true };
const resultPromise: Promise<ReindexResult> = reindex(options);
const decoded: DecodedCliJsonEnvelope = decodeCliJsonEnvelope({
  kind: 'scip-query-result',
  schemaVersion: CURRENT_CLI_JSON_ENVELOPE_SCHEMA_VERSION,
  producer: { name: 'scip-query', version: 'fixture' },
  command: 'refs',
  resultSchemaVersion: 1,
  args: [],
  options: {},
  result: [],
});

void [index, config, references, resultPromise, decoded, parseSymbol('local 1')];
