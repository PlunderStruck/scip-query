export { resolveIndexStoragePaths } from '../platform/cache-layout.js';
export { loadProjectConfig, initProjectConfig } from './config.js';
export { Watcher, createReindexRunner, resolveReindexWorkerLaunch } from './watch.js';
export type {
  ReindexCancellationResult,
  ReindexDiagnostics,
  ReindexOperation,
  ReindexRunner,
  ReindexRunnerOptions,
  ReindexRunRequest,
  ReindexWorkerLaunch,
  WatchClock,
  WatcherOptions,
  WatcherStopResult,
  WatchSubscription,
  WatchSubscriptionFactory,
  WatchSubscriptionOptions,
} from './watch.js';
export { installSkills } from './setup.js';
export { isScipInstalled, getScipVersion, printScipInstallInstructions } from '../platform/scip-cli.js';
export {
  CLI_ANALYSIS_MANIFEST_SCHEMA_VERSION,
  CLI_EVIDENCE_CONTEXT_SCHEMA_VERSION,
  CLI_JSON_ENVELOPE_KIND,
  CURRENT_CLI_JSON_ENVELOPE_SCHEMA_VERSION,
  LEGACY_CLI_JSON_ENVELOPE_SCHEMA_VERSION,
  decodeCliJsonEnvelope,
  requireCompatibleCliJsonEnvelope,
  supportedCliResultSchemaVersions,
} from './cli-json-envelope.js';
export {
  OBSERVATION_RECEIPT_SCHEMA_VERSION,
  compareObservationReceipts,
  isObservationReceipt,
} from './observation-receipt.js';
export type {
  ObservationAuthorityKind,
  ObservationReceipt,
  ObservationReceiptComparison,
} from './observation-receipt.js';
export type {
  CliAnalysisManifestV1,
  CliEvidenceContextV1,
  CliJsonEnvelopeV1,
  CliJsonProducer,
  CompatibleCliJsonEnvelope,
  DecodedCliJsonEnvelope,
  LegacyCliJsonEnvelope,
} from './cli-json-envelope.js';
