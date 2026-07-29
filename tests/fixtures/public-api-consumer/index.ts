import { ProjectIndex, parseSymbol, type ScipDatabase, type ScipQueryConfig } from 'scip-query';
import { computeEffectiveness, type EffectivenessReport, type OutcomeEvent } from 'scip-query/queries';
import { twinAb, type TwinAbOutcome } from 'scip-query/queries/twin-ab';
import { pathMatchesGlob } from 'scip-query/queries/files';
import { symbolPreexistenceChecker } from 'scip-query/queries/diff-gate';
import { refs, type RefResult } from 'scip-query/queries/refs';
import { resolveMethods, type MethodsResolution } from 'scip-query/queries/methods';
import {
  createBaseContentReader,
  createBaseContentResultReader,
  fileContentAtBase,
  fileContentsAtBase,
  readBaseContent,
  readBaseContents,
  type BaseContentResult,
  type DiffImpactPlan,
} from 'scip-query/queries/diff-impact';
import { reindex, type ReindexOptions, type ReindexResult } from 'scip-query/reindex';
import {
  CURRENT_CLI_JSON_ENVELOPE_SCHEMA_VERSION,
  compareObservationReceipts,
  decodeCliJsonEnvelope,
  type DecodedCliJsonEnvelope,
  type ObservationReceipt,
} from 'scip-query/runtime';

declare const database: ScipDatabase;
declare const config: ScipQueryConfig;

const index = new ProjectIndex(database);
const references: RefResult[] = refs(database, 'login');
const methodResolution: MethodsResolution = resolveMethods(database, { className: 'AuthService' });
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
declare const firstObservation: ObservationReceipt;
declare const secondObservation: ObservationReceipt;
const _sameObservationState: boolean = compareObservationReceipts(firstObservation, secondObservation).compatible;
declare const protectedOutcomeEvents: OutcomeEvent[];
const _protectedEvaluation: EffectivenessReport = computeEffectiveness(protectedOutcomeEvents, {
  protectedGateRunIds: new Set(['externally-attested-gate']),
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
const namedHistorical: string | null = fileContentAtBase({
  projectRoot: '.',
  base: 'HEAD',
  relativePath: 'src/index.ts',
});
const namedHistoricalBatch = fileContentsAtBase({
  projectRoot: '.',
  base: 'HEAD',
  relativePaths: ['src/index.ts'],
});
const namedLegacyReader = createBaseContentReader({
  projectRoot: '.',
  base: 'HEAD',
  preloadPaths: ['src/index.ts'],
});
const legacyHistorical: string | null = fileContentAtBase('.', 'HEAD', 'src/index.ts');
const legacyHistoricalBatch = fileContentsAtBase('.', 'HEAD', ['src/index.ts']);
const legacyReader = createBaseContentReader('.', 'HEAD', ['src/index.ts']);
const twins: TwinAbOutcome = twinAb(database, {
  refA: 'escapeRegex',
  refB: 'escapeRegExp',
  outFile: '/tmp/twin.test.ts',
});
const legacyTwins: TwinAbOutcome = twinAb(database, 'escapeRegex', 'escapeRegExp', '/tmp/twin.test.ts');
const globMatches: boolean = pathMatchesGlob({ pattern: 'src/*.ts', relativePath: 'src/index.ts' });
const legacyGlobMatches: boolean = pathMatchesGlob('src/*.ts', 'src/index.ts');
const diffPlan: DiffImpactPlan = {
  changedFileLines: [],
  changedFiles: [],
  changedRanges: [],
  renamedFiles: [],
};
const preexisted = symbolPreexistenceChecker({ projectRoot: '.', base: 'HEAD', diffPlan });
const legacyPreexisted = symbolPreexistenceChecker('.', 'HEAD', diffPlan);
// @ts-expect-error The named twin contract requires the outFile role.
twinAb(database, { refA: 'escapeRegex', refB: 'escapeRegExp', outputPath: '/tmp/twin.test.ts' });
// @ts-expect-error The named glob contract calls the candidate relativePath.
pathMatchesGlob({ pattern: 'src/*.ts', path: 'src/index.ts' });
// @ts-expect-error The named historical-content contract calls the file relativePath.
fileContentAtBase({ projectRoot: '.', base: 'HEAD', path: 'src/index.ts' });
// @ts-expect-error The named preexistence contract requires the diffPlan role.
symbolPreexistenceChecker({ projectRoot: '.', base: 'HEAD', plan: diffPlan });

void [
  index,
  config,
  references,
  methodResolution,
  preparedRead,
  resultPromise,
  decoded,
  historical,
  historicalBatch,
  historicalReader,
  namedHistorical,
  namedHistoricalBatch,
  namedLegacyReader,
  legacyHistorical,
  legacyHistoricalBatch,
  legacyReader,
  twins,
  legacyTwins,
  globMatches,
  legacyGlobMatches,
  preexisted,
  legacyPreexisted,
  parseSymbol('local 1'),
];
