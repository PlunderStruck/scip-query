import { ProjectIndex, parseSymbol, type ScipDatabase, type ScipQueryConfig } from 'scip-query';
import { refs, type RefResult } from 'scip-query/queries/refs';
import {
  createBaseContentResultReader,
  fileContentAtBase,
  readBaseContent,
  readBaseContents,
  type BaseContentResult,
} from 'scip-query/queries/diff-impact';
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
const preparedRead = database.db.prepare('SELECT 1 AS value').get();
// @ts-expect-error The public query port does not own the connection lifecycle.
database.db.close();
// @ts-expect-error Mutable connection configuration is private to ScipDatabase.
database.db.pragma('query_only = OFF');
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
const historical: BaseContentResult = readBaseContent({
  projectRoot: '.',
  base: 'HEAD',
  relativePath: 'src/index.ts',
});
const historicalBatch = readBaseContents({
  projectRoot: '.',
  base: 'HEAD',
  relativePaths: ['src/index.ts'],
});
const historicalReader = createBaseContentResultReader({
  projectRoot: '.',
  base: 'HEAD',
  preloadPaths: ['src/index.ts'],
});
const legacyHistorical: string | null = fileContentAtBase('.', 'HEAD', 'src/index.ts');

void [
  index,
  config,
  references,
  preparedRead,
  resultPromise,
  decoded,
  historical,
  historicalBatch,
  historicalReader,
  legacyHistorical,
  parseSymbol('local 1'),
];
