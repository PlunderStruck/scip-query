export { resolveIndexStoragePaths } from '../platform/cache-layout.js';
export { loadProjectConfig, initProjectConfig } from './config.js';
export { Watcher, resolveReindexWorkerLaunch } from './watch.js';
export type {
  ReindexRunner,
  ReindexRunRequest,
  ReindexWorkerLaunch,
  WatchClock,
  WatcherOptions,
  WatchSubscription,
  WatchSubscriptionFactory,
  WatchSubscriptionOptions,
} from './watch.js';
export { installSkills } from './setup.js';
export { isScipInstalled, getScipVersion, printScipInstallInstructions } from '../platform/scip-cli.js';
