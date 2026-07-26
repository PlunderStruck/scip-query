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
  CLI_JSON_ENVELOPE_KIND,
  CURRENT_CLI_JSON_ENVELOPE_SCHEMA_VERSION,
  LEGACY_CLI_JSON_ENVELOPE_SCHEMA_VERSION,
  decodeCliJsonEnvelope,
  requireCompatibleCliJsonEnvelope,
  supportedCliResultSchemaVersions,
} from './cli-json-envelope.js';
export type {
  CliJsonEnvelopeV1,
  CliJsonProducer,
  CompatibleCliJsonEnvelope,
  DecodedCliJsonEnvelope,
  LegacyCliJsonEnvelope,
} from './cli-json-envelope.js';
