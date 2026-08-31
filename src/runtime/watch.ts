import { existsSync, lstatSync, statSync, watch as watchNative, type FSWatcher } from 'node:fs';
import { EventEmitter } from 'node:events';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { watch as watchWithChokidar } from 'chokidar';
import ignore from 'ignore';
import type {
  RefreshTrigger,
  WatcherStatus,
  ProjectConfig,
  SupportedLanguage,
  TypeScriptProjectMode,
} from '../domain/types.js';
import { classifyProjectInputPath, projectInputSnapshotOrNull } from '../domain/project-input.js';
import { decodeReindexMetadata } from '../domain/reindex-metadata.js';
import { readSmallArtifactText } from '../platform/bounded-file.js';
import type { ProcessIdentity } from '../domain/process-identity.js';
import { monotonicNowMs } from '../domain/time.js';
import {
  MAX_PROJECT_INPUT_CHANGE_ENTRIES,
  PROJECT_INPUT_CHANGE_JOURNAL_VERSION,
  serializeProjectInputChangeJournal,
  type ProjectInputChangeEntry,
  type ProjectInputChangeJournal,
  type ProjectInputChangeKind,
} from '../domain/project-input-change-journal.js';
import { resolveCacheDirPath, resolveIndexStoragePaths } from '../platform/cache-layout.js';
import { normalizeProjectInputFingerprintConfiguration } from '../platform/project-files.js';
import { isTypeScriptProjectConfigPath, typeScriptProjectInputPaths } from '../platform/typescript-projects.js';
import { loadProjectConfig, resolveWatchConfig, SUPPORTED_LANGUAGES, type ResolvedWatchConfig } from './config.js';
import { createGitignoreFilter } from '../source/primitives/gitignore-filter.js';
import { DEFAULT_GIT_READER, gitOutput, resolveGitPath, type GitReader } from '../platform/git-worktree.js';
import {
  inspectReindexActivityBudget,
  REINDEX_ACTIVITY_FILE,
  type ReindexActivityBudgetDecision,
} from '../reindex/reindex-activity.js';
import { REINDEX_WORKER_RETRYABLE_EXIT_CODE } from '../reindex/reindex-worker-protocol.js';
import { BoundedProcessError, runBoundedProcess } from '../platform/bounded-process.js';
import { readProcessIdentity } from '../platform/process-identity.js';
import { publishedSqliteGenerationIdentity } from '../storage/sqlite-generation.js';

export interface WatcherOptions {
  projectRoot: string;
  config: ProjectConfig;
  languages?: SupportedLanguage[];
  reindexRunner?: ReindexRunner;
  subscriptionFactory?: WatchSubscriptionFactory;
  budgetInspector?: WatchBudgetInspector;
  gitReader?: GitReader;
  outputDb?: string;
  clock?: WatchClock;
  stopTimeoutMs?: number;
  onStatus?: (status: WatcherStatus) => void;
  onReindexComplete?: (
    durationMs: number,
    trigger: RefreshTrigger,
    context?: ReindexCompletionContext,
  ) => boolean | void;
  onReindexError?: (error: Error, trigger: RefreshTrigger) => void;
  onRefreshSuppressed?: (trigger: RefreshTrigger) => void;
  onError?: (error: Error) => void;
}

export interface ReindexCompletionContext {
  /** True when a filesystem or refresh event arrived after this run began. */
  pendingChanges: boolean;
}

export type WatchBudgetInspector = (
  outputDb: string,
  config: ResolvedWatchConfig['resourceBudget'],
  now: Date,
) => ReindexActivityBudgetDecision;

export interface ReindexRunRequest {
  projectRoot: string;
  config: ProjectConfig;
  languages?: SupportedLanguage[];
  pnpmWorkspaces: boolean;
  typescriptProjectMode?: TypeScriptProjectMode;
  typescriptProjects?: string[];
  clojureConfigPath?: string;
  indexerConcurrency?: number;
  trigger: RefreshTrigger;
  /** Exact watcher changes since the immutable generation named by the journal. */
  changeJournal?: ProjectInputChangeJournal;
  /** When false, skip full language indexers and keep the previous shard. Default true. */
  allowExpensiveRebuild?: boolean;
}

export interface ReindexWorkerLaunch {
  workerPath: string;
  env: NodeJS.ProcessEnv;
}

export interface ReindexRunner {
  start(request: ReindexRunRequest): ReindexOperation;
}

export interface ReindexDiagnostics {
  stdoutTail: string;
  stderrTail: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export type ReindexCancellationResult =
  | { state: 'exited'; diagnostics: ReindexDiagnostics }
  | { state: 'degraded'; reason: string; diagnostics: ReindexDiagnostics };

export interface ReindexOperation {
  completion: Promise<number>;
  cancel(): Promise<ReindexCancellationResult>;
  diagnostics(): ReindexDiagnostics;
}

export type WatcherStopResult = { state: 'stopped' } | { state: 'degraded'; reasons: string[] };
export const WATCHER_STOP_TIMEOUT_MS = 5_000;

export interface ReindexRunnerOptions {
  timeoutMs?: number;
  terminationGraceMs?: number;
  maxOutputBytes?: number;
  resolveLaunch?: (request: ReindexRunRequest) => ReindexWorkerLaunch;
}

export interface WatchSubscription {
  on(event: 'all', listener: (eventName: string, path: string) => void): WatchSubscription;
  on(event: 'error', listener: (error: unknown) => void): WatchSubscription;
  close(): void | Promise<void>;
}

export type WatchSubscriptionOptions = NonNullable<Parameters<typeof watchWithChokidar>[1]>;
export type WatchSubscriptionFactory = (projectRoot: string, options: WatchSubscriptionOptions) => WatchSubscription;

type WatchTimer = ReturnType<typeof setTimeout>;

export interface WatchClock {
  /** Process-local elapsed clock used for debounce/cooldown control. */
  now(): number;
  /** Civil clock used only in externally visible status timestamps. */
  wallNow?(): number;
  setTimeout(callback: () => void, delayMs: number): WatchTimer;
  clearTimeout(timer: WatchTimer): void;
  setInterval(callback: () => void, intervalMs: number): WatchTimer;
  clearInterval(timer: WatchTimer): void;
}

interface GitStateSnapshot {
  head?: string;
  indexPath?: string;
  indexMtimeMs?: number;
  indexSize?: number;
}

/**
 * File watcher that triggers single-flight background reindexing.
 *
 * Design:
 *  - Debounce: waits for a configurable quiet period after the last file change
 *  - Single-flight: only one reindex runs at a time, never queued
 *  - Dirty flag: changes during reindex cancel stale work and schedule ONE follow-up
 *  - Cooldown: minimum interval between reindex completions
 *  - Atomic publish: the reindexer writes temp artifacts, then promotes them
 */
export class Watcher {
  private projectRoot: string;
  private config: ProjectConfig;
  private watchConfig: ResolvedWatchConfig;
  private outputDb: string;
  private languages?: SupportedLanguage[];
  private pnpmWorkspaces: boolean;
  private typescriptProjectMode?: TypeScriptProjectMode;
  private typescriptProjects?: string[];
  private clojureConfigPath?: string;
  private indexerConcurrency?: number;

  private onStatus: (status: WatcherStatus) => void;
  private onReindexComplete: (
    durationMs: number,
    trigger: RefreshTrigger,
    context?: ReindexCompletionContext,
  ) => boolean | void;
  private onReindexError: (error: Error, trigger: RefreshTrigger) => void;
  private onRefreshSuppressed: (trigger: RefreshTrigger) => void;
  private onError: (error: Error) => void;
  private reindexRunner: ReindexRunner;
  private subscriptionFactory: WatchSubscriptionFactory;
  private budgetInspector: WatchBudgetInspector;
  private clock: WatchClock;
  private activeOperation: ReindexOperation | null = null;
  private stopPromise: Promise<WatcherStopResult> | null = null;
  private stopInProgress = false;

  // State machine
  private status: WatcherStatus = { state: 'idle' };
  private debounceTimer: WatchTimer | null = null;
  private cooldownTimer: WatchTimer | null = null;
  private budgetTimer: WatchTimer | null = null;
  private dirty = false;
  private changedFiles = 0;
  private pendingTrigger: RefreshTrigger | null = null;
  private pendingChanges = new Map<string, ProjectInputChangeKind>();
  private pendingChangesComplete = true;
  private pendingChangesIncompleteReason: string | undefined;
  private reindexInFlight = false;
  private lastReindexEnd = 0;

  // Chokidar maintains the platform-specific subscriptions beneath each root.
  private fsWatchers: WatchSubscription[] = [];
  private sourcePollingFallbackStarted = false;
  private gitPollTimer: WatchTimer | null = null;
  private lastGitState: GitStateSnapshot | null = null;
  /** When unset, idle Git polls read HEAD/index from the filesystem instead of spawning git. */
  private preferFilesystemGitState = true;
  private watchGitLayout: WatchGitLayout | null = null;
  /** Project-relative cache directory; ignored so reindex artifacts do not wake the watcher. */
  private localCacheWatchPath: string | undefined;
  private gitignoreFilter: ReturnType<typeof createGitignoreFilter>;
  private extraIgnore: ReturnType<typeof ignore>;
  private stopped = false;

  constructor(opts: WatcherOptions) {
    this.projectRoot = opts.projectRoot;
    this.config = opts.config;
    this.watchConfig = resolveWatchConfig(opts.config);
    this.outputDb = opts.outputDb ?? join(resolveCacheDirPath(this.projectRoot, opts.config), 'index.db');
    this.preferFilesystemGitState = opts.gitReader === undefined;
    this.localCacheWatchPath = localCacheWatchPath(this.projectRoot, dirname(this.outputDb));
    this.languages = opts.languages;
    this.pnpmWorkspaces = opts.config.indexer?.typescript?.pnpmWorkspaces ?? false;
    this.typescriptProjectMode = opts.config.indexer?.typescript?.projectMode;
    this.typescriptProjects = opts.config.indexer?.typescript?.projects;
    this.clojureConfigPath = opts.config.indexer?.clojure?.configPath;
    this.indexerConcurrency = opts.config.indexerConcurrency;

    this.onStatus = opts.onStatus ?? (() => {});
    this.onReindexComplete = opts.onReindexComplete ?? (() => {});
    this.onReindexError = opts.onReindexError ?? (() => {});
    this.onRefreshSuppressed = opts.onRefreshSuppressed ?? (() => {});
    this.onError = opts.onError ?? ((e) => console.error(e.message));
    this.clock = opts.clock ?? SYSTEM_WATCH_CLOCK;
    watcherStopTimeouts.set(
      this,
      positiveDuration(opts.stopTimeoutMs ?? WATCHER_STOP_TIMEOUT_MS, 'watcher stop timeout'),
    );
    this.reindexRunner = opts.reindexRunner ?? createReindexRunner();
    this.subscriptionFactory = opts.subscriptionFactory ?? defaultWatchSubscriptionFactory;
    this.budgetInspector = opts.budgetInspector ?? inspectReindexActivityBudget;
    watcherInputStates.set(this, {
      projectRoot: opts.projectRoot,
      config: opts.config,
      gitReader: opts.gitReader ?? DEFAULT_GIT_READER,
      languages: resolveWatchInputLanguages(opts.languages ?? opts.config.languages),
      typeScriptInputPaths: null,
      stagedIndexEntries: null,
    });

    this.gitignoreFilter = createGitignoreFilter(opts.projectRoot);
    this.extraIgnore = ignore();
    if (this.watchConfig.ignore.length > 0) {
      this.extraIgnore.add(this.watchConfig.ignore);
    }
    refreshPublishedTypeScriptInputScope(this);
  }

  /** Start watching for file changes */
  // scip-query: ignore-extract — this wires the watcher lifecycle: initial
  // status, chokidar subscription, debounce handling, and close semantics are
  // one runtime boundary.
  start(): void {
    if (this.stopInProgress) {
      throw new Error('Cannot restart a watcher while its previous ownership is still draining.');
    }
    this.stopped = false;
    this.stopPromise = null;
    watcherRetirementState(this).errors = [];
    this.sourcePollingFallbackStarted = false;
    this.setStatus({ state: 'idle' });
    this.startGitStatePolling();

    try {
      this.startSourceWatcher();
    } catch (error) {
      this.onError(new Error(`Failed to watch ${this.projectRoot}: ${String(error)}`));
    }
  }

  /** Stop watching and clean up */
  stop(): Promise<WatcherStopResult> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.stopInProgress = true;
    const subscriptions = this.fsWatchers;
    this.fsWatchers = [];
    this.clearDebounceTimer();
    this.clearCooldownTimer();
    this.clearBudgetTimer();
    this.clearGitPollTimer();
    const operation = this.activeOperation;
    if (operation) {
      this.setStatus({
        state: 'draining',
        startedAt: this.wallNow(),
        reason: 'waiting for the active reindex worker to exit',
      });
    }
    const retirements = [...watcherRetirementState(this).closures];
    const stopTimeoutMs = watcherStopTimeout(this);
    const deadlineAtMs = this.clock.now() + stopTimeoutMs;
    this.stopPromise = this.finishStop(subscriptions, retirements, operation, deadlineAtMs, stopTimeoutMs).catch(
      (error: unknown) => {
        this.stopInProgress = false;
        throw error;
      },
    );
    return this.stopPromise;
  }

  /** Request a refresh through the same single-flight/coalescing state machine used by file events. */
  requestRefresh(trigger: RefreshTrigger, opts: { immediate?: boolean } = {}): void {
    if (this.stopped) return;
    this.markPendingChangesIncomplete(`unstructured-trigger:${trigger.kind}`);
    if (
      !opts.immediate ||
      this.reindexInFlight ||
      this.status.state === 'cooldown' ||
      this.status.state === 'budget-paused'
    ) {
      this.scheduleReindex(trigger);
      return;
    }
    this.pendingTrigger = mergeRefreshTrigger(this.pendingTrigger, trigger);
    this.changedFiles += 1;
    this.clearDebounceTimer();
    this.triggerReindex();
  }

  // ── Internal ─────────────────────────────────────────────

  private startSourceWatcher(usePolling = false): void {
    const watcher = this.subscriptionFactory(this.projectRoot, {
      ignoreInitial: true,
      ignored: (path, stats) => this.isIgnoredWatchPath(path, stats?.isDirectory() ?? false),
      usePolling,
      ignorePermissionErrors: true,
      ...(usePolling ? { interval: 5_000, binaryInterval: 10_000 } : {}),
    });
    watcher.on('all', (event, path) => {
      if (!this.stopped && event !== 'addDir' && event !== 'unlinkDir') this.handleFileChange(event, path);
    });
    watcher.on('error', (error) => this.handleSourceWatcherError(watcher, error, usePolling));
    this.fsWatchers.push(watcher);
  }

  private handleSourceWatcherError(watcher: WatchSubscription, error: unknown, usePolling: boolean): void {
    this.markPendingChangesIncomplete('source-watcher-error');
    if (usePolling || this.sourcePollingFallbackStarted || !isSourceWatcherFallbackError(error) || this.stopped) {
      this.onError(new Error(`Failed to watch ${this.projectRoot}: ${String(error)}`));
      return;
    }

    this.sourcePollingFallbackStarted = true;
    this.fsWatchers = this.fsWatchers.filter((candidate) => candidate !== watcher);
    retireWatchSubscription(watcherRetirementState(this), watcher, (retirementError) => this.onError(retirementError));
    try {
      this.startSourceWatcher(true);
    } catch (fallbackError) {
      this.onError(new Error(`Failed to watch ${this.projectRoot}: ${String(fallbackError)}`));
    }
  }

  private isIgnoredWatchPath(path: string, isDirectory: boolean): boolean {
    const relativePath = this.relativeWatchPath(path);
    if (!relativePath) return false;
    if (isCheapIgnoredWatchPath(relativePath, this.localCacheWatchPath)) return true;

    const candidate = isDirectory ? `${relativePath}/` : relativePath;
    return this.gitignoreFilter.isIgnored(candidate) || this.extraIgnore.ignores(candidate);
  }

  private handleFileChange(event: string, filename: string): void {
    // Filter: skip gitignored files and extra ignore patterns
    const rel = this.relativeWatchPath(filename);
    if (!rel || rel === '..' || rel.startsWith('../')) return;
    if (isCheapIgnoredWatchPath(rel, this.localCacheWatchPath)) return;
    if (this.gitignoreFilter.isIgnored(rel)) return;
    if (this.extraIgnore.ignores(rel)) return;
    // Skip the index files themselves
    if (
      rel.endsWith('index.db') ||
      rel.endsWith('index.scip') ||
      rel.endsWith('index.db.tmp') ||
      basename(rel).startsWith(REINDEX_ACTIVITY_FILE)
    ) {
      return;
    }

    if (rel === '.scipquery.json') refreshWatchInputLanguages(this, this.projectRoot);
    const changeKind = scopedProjectInputChangeKind(this, event, rel);
    if (changeKind === null) return;
    if (!changeKind) this.markPendingChangesIncomplete(`unsupported-source-event:${event}`);
    this.scheduleReindex(
      { kind: 'watch-source', detail: rel },
      changeKind ? [{ path: rel, kind: changeKind }] : undefined,
      changeKind !== undefined,
    );
  }

  private relativeWatchPath(path: string): string {
    const absolutePath = isAbsolute(path) ? path : join(this.projectRoot, path);
    return relative(this.projectRoot, absolutePath).replaceAll('\\', '/');
  }

  private scheduleReindex(
    trigger: RefreshTrigger,
    changes?: readonly ProjectInputChangeEntry[],
    changesComplete = false,
  ): void {
    this.pendingTrigger = mergeRefreshTrigger(this.pendingTrigger, trigger);
    if (!changesComplete) this.markPendingChangesIncomplete(`unstructured-trigger:${trigger.kind}`);
    for (const change of changes ?? []) this.recordPendingChange(change);
    this.changedFiles++;

    if (this.reindexInFlight) {
      // The accepted snapshot can no longer match the working tree. Cancel
      // the stale attempt once and retain every change for one follow-up.
      this.dirty = true;
      this.setStatus({
        state: 'indexing',
        startedAt: (this.status as { startedAt: number }).startedAt,
      });
      const operation = this.activeOperation;
      if (operation && watcherSupersededOperations.get(this) !== operation) {
        watcherSupersededOperations.set(this, operation);
        void operation.cancel().then(
          (result) => {
            if (result.state === 'degraded' && !this.stopped) this.onError(new Error(result.reason));
          },
          (error: unknown) => {
            if (!this.stopped) this.onError(error instanceof Error ? error : new Error(String(error)));
          },
        );
      }
      return;
    }

    if (this.status.state === 'cooldown') {
      // In cooldown — mark dirty, the cooldown handler will pick it up
      this.dirty = true;
      this.setStatus({ state: 'cooldown', until: (this.status as { until: number }).until, dirty: true });
      return;
    }
    if (this.status.state === 'budget-paused') {
      this.dirty = true;
      this.setStatus({ ...this.status, dirty: true });
      return;
    }

    // Reset the debounce timer — every new change pushes the trigger out
    this.clearDebounceTimer();

    const reindexAt = this.wallNow() + this.watchConfig.debounceMs;
    this.setStatus({ state: 'waiting', changedFiles: this.changedFiles, reindexAt });

    this.debounceTimer = this.clock.setTimeout(() => {
      this.debounceTimer = null;
      this.triggerReindex();
    }, this.watchConfig.debounceMs);
  }

  // scip-query: ignore-extract — this method is the watcher's state machine:
  // cooldown, in-flight state, retry scheduling, and error recovery must stay
  // visible together.
  private triggerReindex(): void {
    if (this.reindexInFlight || this.stopped) return;

    const budget = this.inspectBudget();
    const allowExpensiveRebuild = this.watchConfig.allowExpensiveRebuild && budget.state !== 'paused';
    if (budget.state === 'paused' && budget.reason !== 'rebuild-count') {
      this.dirty = true;
      const until = Math.max(this.wallNow() + 1, budget.until);
      this.setStatus({
        state: 'budget-paused',
        until,
        dirty: true,
        reason: budget.detail,
        rebuilt: budget.rebuilt,
        estimatedWriteBytes: budget.estimatedWriteBytes,
      });
      this.clearBudgetTimer();
      this.budgetTimer = this.clock.setTimeout(
        () => {
          this.budgetTimer = null;
          if (this.dirty && !this.stopped) {
            this.dirty = false;
            this.triggerReindex();
          }
        },
        Math.min(2_147_483_647, Math.max(1, until - this.wallNow())),
      );
      return;
    }

    // Check cooldown
    const timeSinceLastReindex = this.clock.now() - this.lastReindexEnd;
    if (this.lastReindexEnd > 0 && timeSinceLastReindex < this.watchConfig.cooldownMs) {
      const remaining = this.watchConfig.cooldownMs - timeSinceLastReindex;
      this.dirty = true;
      const until = this.wallNow() + remaining;
      this.setStatus({ state: 'cooldown', until, dirty: true });

      this.cooldownTimer = this.clock.setTimeout(() => {
        this.cooldownTimer = null;
        if (this.dirty && !this.stopped) {
          this.dirty = false;
          this.triggerReindex();
        }
      }, remaining);
      return;
    }

    this.reindexInFlight = true;
    this.dirty = false;
    this.changedFiles = 0;
    const trigger = this.pendingTrigger ?? { kind: 'watch-source' };
    this.pendingTrigger = null;
    const changeJournal = this.consumePendingChangeJournal();
    const startedAt = this.wallNow();
    this.setStatus({ state: 'indexing', startedAt });

    // Run reindex in a child process so it doesn't block the watcher
    const operation = this.reindexRunner.start(this.reindexRequest(trigger, allowExpensiveRebuild, changeJournal));
    this.activeOperation = operation;
    operation.completion
      .then((durationMs) => {
        this.reindexInFlight = false;
        this.lastReindexEnd = this.clock.now();
        watcherRetryableReindexFailures.set(this, 0);
        if (this.stopped) return;
        if (watcherSupersededOperations.get(this) === operation) {
          this.restorePendingChangeJournal(changeJournal);
          if (this.dirty) {
            const until = this.wallNow() + this.watchConfig.cooldownMs;
            this.setStatus({ state: 'cooldown', until, dirty: true });
            this.clearCooldownTimer();
            this.cooldownTimer = this.clock.setTimeout(() => {
              this.cooldownTimer = null;
              if (this.dirty && !this.stopped) {
                this.dirty = false;
                this.triggerReindex();
              } else {
                this.setStatus({ state: 'idle' });
              }
            }, this.watchConfig.cooldownMs);
          } else this.setStatus({ state: 'idle' });
          return;
        }
        refreshPublishedTypeScriptInputScope(this);
        let completedIndexIsFresh = false;
        try {
          completedIndexIsFresh = this.onReindexComplete(durationMs, trigger, { pendingChanges: this.dirty }) === true;
        } catch (error) {
          this.onError(error instanceof Error ? error : new Error(String(error)));
        }

        if (this.dirty && !this.stopped) {
          if (completedIndexIsFresh) {
            const suppressedTrigger = this.pendingTrigger ?? { kind: 'unknown' };
            this.dirty = false;
            this.changedFiles = 0;
            this.pendingTrigger = null;
            this.resetPendingChanges();
            this.onRefreshSuppressed(suppressedTrigger);
            this.setStatus({ state: 'idle' });
            return;
          }
          // Changes arrived during reindex — enter cooldown then reindex again
          const until = this.wallNow() + this.watchConfig.cooldownMs;
          this.setStatus({ state: 'cooldown', until, dirty: true });
          this.clearCooldownTimer();
          this.cooldownTimer = this.clock.setTimeout(() => {
            this.cooldownTimer = null;
            if (this.dirty && !this.stopped) {
              this.dirty = false;
              this.triggerReindex();
            } else {
              this.setStatus({ state: 'idle' });
            }
          }, this.watchConfig.cooldownMs);
        } else {
          this.setStatus({ state: 'idle' });
        }
      })
      .catch((err) => {
        this.reindexInFlight = false;
        this.lastReindexEnd = this.clock.now();
        if (this.stopped) return;
        const error = err instanceof Error ? err : new Error(String(err));
        this.restorePendingChangeJournal(changeJournal);
        const retryable = isRetryableReindexFailure(error);
        let retryableFailures = 0;
        if (retryable) {
          retryableFailures = (watcherRetryableReindexFailures.get(this) ?? 0) + 1;
          watcherRetryableReindexFailures.set(this, retryableFailures);
          this.dirty = true;
          this.pendingTrigger = mergeRefreshTrigger(this.pendingTrigger, trigger);
        } else {
          watcherRetryableReindexFailures.set(this, 0);
        }
        if (!retryable && watcherSupersededOperations.get(this) !== operation) {
          this.onReindexError(error, trigger);
          this.onError(error);
        }
        if (this.dirty) {
          const retryDelayMs = retryable
            ? retryableReindexDelayMs(this.watchConfig.cooldownMs, retryableFailures)
            : this.watchConfig.cooldownMs;
          const until = this.wallNow() + retryDelayMs;
          this.setStatus({ state: 'cooldown', until, dirty: true });
          this.clearCooldownTimer();
          this.cooldownTimer = this.clock.setTimeout(() => {
            this.cooldownTimer = null;
            if (this.dirty && !this.stopped) {
              this.dirty = false;
              this.triggerReindex();
            } else {
              this.setStatus({ state: 'idle' });
            }
          }, retryDelayMs);
          return;
        }
        this.setStatus({ state: 'idle' });
      })
      .finally(() => {
        if (this.activeOperation === operation) this.activeOperation = null;
        if (watcherSupersededOperations.get(this) === operation) watcherSupersededOperations.delete(this);
      });
  }

  private async finishStop(
    subscriptions: readonly WatchSubscription[],
    retirements: readonly Promise<void>[],
    operation: ReindexOperation | null,
    deadlineAtMs: number,
    stopTimeoutMs: number,
  ): Promise<WatcherStopResult> {
    const reasons: string[] = [];
    const tasks: Promise<void>[] = subscriptions.map(async (subscription) => {
      try {
        await subscription.close();
      } catch (error) {
        reasons.push(`watch subscription close failed: ${String(error)}`);
      }
    });
    tasks.push(...retirements);
    if (operation) {
      tasks.push(
        (async () => {
          try {
            const cancellation = await operation.cancel();
            if (cancellation.state === 'degraded') reasons.push(cancellation.reason);
          } catch (error) {
            reasons.push(`reindex cancellation failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        })(),
      );
    }
    let pendingTasks = tasks.length;
    const trackedTasks = tasks.map((task) =>
      task.finally(() => {
        pendingTasks -= 1;
      }),
    );
    const completed = await waitForWatcherShutdownTasks(trackedTasks, deadlineAtMs, this.clock);
    const retirement = watcherRetirementState(this);
    reasons.push(...retirement.errors);
    retirement.errors = [];
    if (!completed) {
      reasons.push(
        `watch shutdown exceeded the ${stopTimeoutMs}ms deadline with ${pendingTasks} operation(s) still pending`,
      );
      void Promise.all(trackedTasks).then(() => {
        this.stopInProgress = false;
      });
    } else {
      this.stopInProgress = false;
    }
    if (reasons.length > 0) {
      this.setStatus({
        state: 'draining',
        startedAt: this.wallNow(),
        reason: reasons.join('; '),
      });
      return { state: 'degraded', reasons };
    }
    this.setStatus({ state: 'idle' });
    return { state: 'stopped' };
  }

  private wallNow(): number {
    return this.clock.wallNow?.() ?? this.clock.now();
  }

  private inspectBudget(): ReindexActivityBudgetDecision {
    try {
      return this.budgetInspector(this.outputDb, this.watchConfig.resourceBudget, new Date(this.wallNow()));
    } catch (error) {
      return {
        state: 'paused',
        reason: 'activity-evidence',
        until: this.wallNow() + this.watchConfig.resourceBudget.windowMs,
        rebuilt: 0,
        estimatedWriteBytes: 0,
        detail: `reindex activity evidence could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  private reindexRequest(
    trigger: RefreshTrigger,
    allowExpensiveRebuild = true,
    changeJournal?: ProjectInputChangeJournal,
  ): ReindexRunRequest {
    return {
      projectRoot: this.projectRoot,
      config: this.config,
      languages: this.languages,
      pnpmWorkspaces: this.pnpmWorkspaces,
      typescriptProjectMode: this.typescriptProjectMode,
      typescriptProjects: this.typescriptProjects,
      clojureConfigPath: this.clojureConfigPath,
      indexerConcurrency: this.indexerConcurrency,
      trigger,
      changeJournal,
      allowExpensiveRebuild,
    };
  }

  private setStatus(status: WatcherStatus): void {
    this.status = status;
    this.onStatus(status);
  }

  private recordPendingChange(change: ProjectInputChangeEntry): void {
    if (this.pendingChanges.size >= MAX_PROJECT_INPUT_CHANGE_ENTRIES && !this.pendingChanges.has(change.path)) {
      this.pendingChanges.clear();
      this.markPendingChangesIncomplete('change-entry-limit');
      return;
    }
    const previous = this.pendingChanges.get(change.path);
    const merged = mergeProjectInputChangeKind(previous, change.kind);
    if (merged === null) this.pendingChanges.delete(change.path);
    else this.pendingChanges.set(change.path, merged);
  }

  private markPendingChangesIncomplete(reason: string): void {
    this.pendingChangesComplete = false;
    this.pendingChangesIncompleteReason ??= reason;
  }

  private consumePendingChangeJournal(): ProjectInputChangeJournal {
    const baseGeneration = publishedSqliteGenerationIdentity(this.outputDb);
    const entries = [...this.pendingChanges.entries()]
      .map(([path, kind]) => ({ path, kind }))
      .sort((a, b) => a.path.localeCompare(b.path));
    let complete = this.pendingChangesComplete;
    let incompleteReason = this.pendingChangesIncompleteReason;
    if (!baseGeneration) {
      complete = false;
      incompleteReason ??= 'accepted-generation-unavailable';
    }
    let journal: ProjectInputChangeJournal = {
      version: PROJECT_INPUT_CHANGE_JOURNAL_VERSION,
      baseGeneration,
      complete,
      ...(incompleteReason ? { incompleteReason } : {}),
      entries,
    };
    if (!serializeProjectInputChangeJournal(journal)) {
      journal = {
        version: PROJECT_INPUT_CHANGE_JOURNAL_VERSION,
        baseGeneration,
        complete: false,
        incompleteReason: 'change-journal-byte-limit',
        entries: [],
      };
    }
    this.resetPendingChanges();
    return journal;
  }

  private restorePendingChangeJournal(journal: ProjectInputChangeJournal): void {
    const laterEntries = [...this.pendingChanges.entries()].map(([path, kind]) => ({ path, kind }));
    const laterComplete = this.pendingChangesComplete;
    const laterIncompleteReason = this.pendingChangesIncompleteReason;
    this.resetPendingChanges();
    if (!journal.complete) this.markPendingChangesIncomplete(journal.incompleteReason ?? 'failed-reindex');
    for (const entry of journal.entries) this.recordPendingChange(entry);
    if (!laterComplete) this.markPendingChangesIncomplete(laterIncompleteReason ?? 'failed-reindex');
    for (const entry of laterEntries) this.recordPendingChange(entry);
  }

  private resetPendingChanges(): void {
    this.pendingChanges.clear();
    this.pendingChangesComplete = true;
    this.pendingChangesIncompleteReason = undefined;
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimer) {
      this.clock.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private clearCooldownTimer(): void {
    if (this.cooldownTimer) {
      this.clock.clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
  }

  private clearBudgetTimer(): void {
    if (this.budgetTimer) {
      this.clock.clearTimeout(this.budgetTimer);
      this.budgetTimer = null;
    }
  }

  private startGitStatePolling(): void {
    this.lastGitState = this.readGitState();
    if (!this.lastGitState) return;
    watcherInputState(this).stagedIndexEntries = readStagedIndexEntries(
      this.projectRoot,
      watcherInputState(this).gitReader,
    );
    this.gitPollTimer = this.clock.setInterval(() => this.pollGitState(), this.watchConfig.gitPollMs);
    this.gitPollTimer.unref?.();
  }

  private pollGitState(): void {
    if (this.reindexInFlight || this.stopped) return;
    const previous = this.lastGitState;
    const next = this.readGitState();
    if (!previous || !next || this.stopped) {
      this.lastGitState = next;
      return;
    }

    this.lastGitState = next;
    const headChanged = previous.head !== next.head;
    const indexChanged =
      previous.indexPath !== next.indexPath ||
      previous.indexMtimeMs !== next.indexMtimeMs ||
      previous.indexSize !== next.indexSize;
    if (!headChanged && !indexChanged) return;

    const inputState = watcherInputState(this);
    const previousStagedIndexEntries = inputState.stagedIndexEntries;
    const nextStagedIndexEntries = readStagedIndexEntries(this.projectRoot, inputState.gitReader);
    inputState.stagedIndexEntries = nextStagedIndexEntries;
    const changedPaths = readChangedGitPaths(
      this.projectRoot,
      inputState.gitReader,
      previous,
      next,
      previousStagedIndexEntries,
      nextStagedIndexEntries,
      headChanged,
      indexChanged,
    );
    let relevantPaths: string[] | null = null;
    if (changedPaths !== null) {
      if (changedPaths.includes('.scipquery.json')) refreshWatchInputLanguages(this, this.projectRoot);
      // Git transitions do not retain per-path add/change/delete status here.
      // Treat each candidate as a possible addition so newly selected compiler
      // inputs refresh membership before the transition is discarded.
      relevantPaths = changedPaths.filter((path) => scopedProjectInputChangeKind(this, 'add', path) !== null);
      if (relevantPaths.length === 0) return;
    }
    const changes = relevantPaths?.map<ProjectInputChangeEntry>((path) => ({
      path,
      kind: existsSync(join(this.projectRoot, path)) ? 'change' : 'delete',
    }));

    if (headChanged && indexChanged) {
      this.scheduleReindex(
        {
          kind: 'watch-git-state',
          detail: gitChangeDetail('HEAD and index changed', relevantPaths),
        },
        changes,
        changes !== undefined,
      );
    } else if (headChanged) {
      this.scheduleReindex(
        { kind: 'watch-git-head', detail: gitChangeDetail('HEAD changed', relevantPaths) },
        changes,
        changes !== undefined,
      );
    } else if (indexChanged) {
      this.scheduleReindex(
        {
          kind: 'watch-git-index',
          detail: gitChangeDetail(next.indexPath ?? 'index changed', relevantPaths),
        },
        changes,
        changes !== undefined,
      );
    }
  }

  private readGitState(): GitStateSnapshot | null {
    if (this.preferFilesystemGitState) {
      const filesystem = this.readFilesystemGitState();
      if (filesystem) return filesystem;
    }
    return this.readGitStateFromGit();
  }

  private readFilesystemGitState(): GitStateSnapshot | null {
    const layout = this.watchGitLayout ?? resolveWatchGitLayout(this.projectRoot);
    if (!layout) return null;
    this.watchGitLayout = layout;
    const head = readWatchGitHeadOid(layout.gitDir);
    if (!head) return null;
    return gitStateFromIndexPath(head, layout.indexPath);
  }

  private readGitStateFromGit(): GitStateSnapshot | null {
    const gitReader = watcherInputState(this).gitReader;
    const rawIndexPath = gitOutput(this.projectRoot, ['rev-parse', '--git-path', 'index'], gitReader);
    if (!rawIndexPath) return null;
    const indexPath = resolveGitPath(this.projectRoot, rawIndexPath);
    return gitStateFromIndexPath(gitOutput(this.projectRoot, ['rev-parse', '--verify', 'HEAD'], gitReader), indexPath);
  }

  private clearGitPollTimer(): void {
    if (this.gitPollTimer) {
      this.clock.clearInterval(this.gitPollTimer);
      this.gitPollTimer = null;
    }
  }
}

async function waitForWatcherShutdownTasks(
  tasks: readonly Promise<void>[],
  deadlineAtMs: number,
  clock: WatchClock,
): Promise<boolean> {
  if (tasks.length === 0) return true;
  const completed = Promise.all(tasks).then(() => true);
  const remainingMs = Math.max(0, deadlineAtMs - clock.now());
  let timeout: WatchTimer | null = null;
  const expired = new Promise<boolean>((resolvePromise) => {
    timeout = clock.setTimeout(() => resolvePromise(false), remainingMs);
  });
  const result = await Promise.race([completed, expired]);
  if (result && timeout) clock.clearTimeout(timeout);
  return result;
}

interface WatcherRetirementState {
  closures: Set<Promise<void>>;
  errors: string[];
}

interface WatcherInputState {
  projectRoot: string;
  config: ProjectConfig;
  gitReader: GitReader;
  languages: readonly SupportedLanguage[];
  /** Exact TypeScript-family source membership from the accepted generation. Null keeps correctness conservative. */
  typeScriptInputPaths: ReadonlySet<string> | null;
  stagedIndexEntries: ReadonlyMap<string, string> | null;
}

const watcherRetirementStates = new WeakMap<Watcher, WatcherRetirementState>();
const watcherStopTimeouts = new WeakMap<Watcher, number>();
const watcherInputStates = new WeakMap<Watcher, WatcherInputState>();
const watcherSupersededOperations = new WeakMap<Watcher, ReindexOperation>();
const watcherRetryableReindexFailures = new WeakMap<Watcher, number>();

function watcherRetirementState(watcher: Watcher): WatcherRetirementState {
  const existing = watcherRetirementStates.get(watcher);
  if (existing) return existing;
  const created: WatcherRetirementState = { closures: new Set(), errors: [] };
  watcherRetirementStates.set(watcher, created);
  return created;
}

function watcherStopTimeout(watcher: Watcher): number {
  return watcherStopTimeouts.get(watcher) ?? WATCHER_STOP_TIMEOUT_MS;
}

function watcherInputState(watcher: Watcher): WatcherInputState {
  const state = watcherInputStates.get(watcher);
  if (!state) throw new Error('Watcher input state was not initialized.');
  return state;
}

function retireWatchSubscription(
  retirement: WatcherRetirementState,
  subscription: WatchSubscription,
  onError: (error: Error) => void,
): void {
  const closure = Promise.resolve()
    .then(() => subscription.close())
    .catch((error: unknown) => {
      const message = `watch subscription close failed during polling fallback: ${String(error)}`;
      retirement.errors.push(message);
      onError(new Error(message));
    });
  retirement.closures.add(closure);
  void closure.then(() => retirement.closures.delete(closure));
}

export function resolveReindexWorkerLaunch(
  request: ReindexRunRequest,
  resolveParentIdentity: (pid: number) => ProcessIdentity | null = readProcessIdentity,
): ReindexWorkerLaunch {
  const {
    projectRoot,
    config,
    languages,
    pnpmWorkspaces,
    typescriptProjectMode,
    typescriptProjects,
    clojureConfigPath,
    indexerConcurrency,
    trigger,
  } = request;
  const loadedConfig = loadProjectConfig(projectRoot);
  const latestConfig = Object.keys(loadedConfig).length > 0 ? loadedConfig : config;
  const latestIndexPaths = resolveIndexStoragePaths(projectRoot, latestConfig);
  const latestTypeScript = latestConfig.indexer?.typescript;
  const latestClojure = latestConfig.indexer?.clojure;
  const parentIdentity = resolveParentIdentity(process.pid);
  if (!parentIdentity) {
    throw new Error(`Could not establish watcher process identity for reindex worker ownership (pid ${process.pid}).`);
  }
  return {
    workerPath: new URL('./reindex-worker.js', import.meta.url).pathname,
    env: {
      ...process.env,
      SCIP_REINDEX_PROJECT_ROOT: projectRoot,
      SCIP_REINDEX_OUTPUT_SCIP: latestIndexPaths.indexPath,
      SCIP_REINDEX_OUTPUT_DB: latestIndexPaths.dbPath,
      SCIP_REINDEX_LANGUAGES: (latestConfig.languages ?? languages)?.join(',') ?? '',
      SCIP_REINDEX_INDEXER_CONCURRENCY: String(latestConfig.indexerConcurrency ?? indexerConcurrency ?? ''),
      SCIP_REINDEX_PNPM_WORKSPACES: (latestTypeScript?.pnpmWorkspaces ?? pnpmWorkspaces) ? '1' : '',
      SCIP_REINDEX_TYPESCRIPT_CONFIG: JSON.stringify({
        projectMode: latestTypeScript?.projectMode ?? typescriptProjectMode,
        projects: latestTypeScript?.projects ?? typescriptProjects ?? [],
        maxHeapMb: latestTypeScript?.maxHeapMb,
      }),
      SCIP_REINDEX_CLOJURE_CONFIG_PATH: latestClojure?.configPath ?? clojureConfigPath ?? '',
      SCIP_REINDEX_TRIGGER_KIND: trigger.kind,
      SCIP_REINDEX_TRIGGER_DETAIL: trigger.detail ?? '',
      SCIP_REINDEX_CHANGE_JOURNAL: request.changeJournal
        ? (serializeProjectInputChangeJournal(request.changeJournal) ?? '')
        : '',
      SCIP_REINDEX_ALLOW_EXPENSIVE: request.allowExpensiveRebuild === false ? '0' : '1',
      SCIP_REINDEX_PROCESS_GROUP_LEADER: '1',
      SCIP_REINDEX_PARENT_IDENTITY: JSON.stringify(parentIdentity),
    },
  };
}

const SYSTEM_WATCH_CLOCK: WatchClock = {
  now: monotonicNowMs,
  wallNow: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (timer) => clearInterval(timer),
};

const defaultWatchSubscriptionFactory: WatchSubscriptionFactory = (projectRoot, options) =>
  shouldUseRecursiveSourceWatch(process.platform, options.usePolling)
    ? new RecursiveSourceWatchSubscription(projectRoot)
    : watchWithChokidar(projectRoot, options);

export function shouldUseRecursiveSourceWatch(platform: NodeJS.Platform, usePolling: boolean | undefined): boolean {
  return platform === 'darwin' && usePolling !== true;
}

export class RecursiveSourceWatchError extends Error {
  // scip-query: ignore-passthrough — named error preserves recursive-watch failure identity and its original cause.
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'RecursiveSourceWatchError';
  }
}

class RecursiveSourceWatchSubscription implements WatchSubscription {
  private readonly events = new EventEmitter();
  private readonly watcher: FSWatcher;

  constructor(projectRoot: string) {
    this.watcher = watchNative(projectRoot, { recursive: true }, (eventName, filename) => {
      if (filename === null) {
        this.events.emit('error', new RecursiveSourceWatchError('Recursive source watcher omitted the changed path.'));
        return;
      }
      const path = join(projectRoot, filename.toString());
      this.events.emit('all', nativeSourceWatchEvent(eventName, path), path);
    });
    this.watcher.on('error', (error) => {
      this.events.emit(
        'error',
        new RecursiveSourceWatchError(`Recursive source watcher failed: ${error.message}`, error),
      );
    });
  }

  on: WatchSubscription['on'] = (event, listener) => {
    this.events.on(event, listener);
    return this;
  };

  close(): void {
    this.watcher.close();
  }
}

function nativeSourceWatchEvent(eventName: string, path: string): 'change' | 'add' | 'addDir' | 'unlink' {
  if (eventName === 'change') return 'change';
  if (!existsSync(path)) return 'unlink';
  return statSync(path).isDirectory() ? 'addDir' : 'add';
}

const WATCH_REINDEX_TIMEOUT_MS = 15 * 60_000;
const WATCH_REINDEX_TERMINATION_GRACE_MS = 1_000;
const WATCH_REINDEX_OUTPUT_TAIL_BYTES = 64 * 1024;

function emptyReindexDiagnostics(): ReindexDiagnostics {
  return {
    stdoutTail: '',
    stderrTail: '',
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function reindexFailureMessage(error: unknown, diagnostics: ReindexDiagnostics): string {
  const base = error instanceof Error ? error.message : String(error);
  const detail = diagnostics.stderrTail.trim() || diagnostics.stdoutTail.trim();
  return detail ? `${base}\n${detail}` : base;
}

function retryableReindexFailure(message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { retryable: true as const });
}

function isRetryableReindexFailure(error: unknown): error is Error & { retryable: true } {
  return error instanceof Error && 'retryable' in error && error.retryable === true;
}

function retryableReindexDelayMs(cooldownMs: number, failures: number): number {
  const exponentialMs = cooldownMs * 2 ** Math.min(5, Math.max(0, failures - 1));
  return Math.max(cooldownMs, Math.min(30_000, exponentialMs));
}

export function createReindexRunner(options: ReindexRunnerOptions = {}): ReindexRunner {
  const timeoutMs = options.timeoutMs ?? WATCH_REINDEX_TIMEOUT_MS;
  const terminationGraceMs = options.terminationGraceMs ?? WATCH_REINDEX_TERMINATION_GRACE_MS;
  const maxOutputBytes = options.maxOutputBytes ?? WATCH_REINDEX_OUTPUT_TAIL_BYTES;
  const resolveLaunch = options.resolveLaunch ?? resolveReindexWorkerLaunch;
  return {
    start(request) {
      const launch = resolveLaunch(request);
      const controller = new AbortController();
      let diagnostics = emptyReindexDiagnostics();
      let settled = false;
      const completion = runBoundedProcess({
        command: process.execPath,
        args: [...process.execArgv, launch.workerPath],
        label: 'watch reindex worker',
        env: launch.env,
        timeoutMs,
        terminationGraceMs,
        maxStdoutBytes: maxOutputBytes,
        maxStderrBytes: maxOutputBytes,
        outputLimitBehavior: 'truncate-tail',
        signal: controller.signal,
        detached: true,
      })
        .then((result) => {
          diagnostics = {
            stdoutTail: result.stdout,
            stderrTail: result.stderr,
            stdoutTruncated: result.stdoutTruncated,
            stderrTruncated: result.stderrTruncated,
          };
          if (result.status !== 0) {
            const message = reindexFailureMessage(
              new Error(
                `Reindex worker exited with ${result.signal ? `signal ${result.signal}` : `code ${result.status}`}`,
              ),
              diagnostics,
            );
            if (result.status === REINDEX_WORKER_RETRYABLE_EXIT_CODE) throw retryableReindexFailure(message);
            throw new Error(message);
          }
          return result.durationMs;
        })
        .catch((error: unknown) => {
          if (isRetryableReindexFailure(error)) throw error;
          if (error instanceof BoundedProcessError) {
            diagnostics = {
              stdoutTail: error.stdout,
              stderrTail: error.stderr,
              stdoutTruncated: error.stdoutTruncated,
              stderrTruncated: error.stderrTruncated,
            };
          }
          throw new Error(reindexFailureMessage(error, diagnostics), { cause: error });
        })
        .finally(() => {
          settled = true;
        });
      return {
        completion,
        async cancel() {
          if (!settled) controller.abort();
          try {
            await completion;
          } catch {
            // Cancellation and worker failure both settle only after close.
          }
          return { state: 'exited', diagnostics };
        },
        diagnostics: () => diagnostics,
      };
    },
  };
}

function mergeRefreshTrigger(current: RefreshTrigger | null, next: RefreshTrigger): RefreshTrigger {
  if (!current) return next;
  if (current.kind === next.kind) {
    if (current.detail === next.detail) return current;
    return { kind: current.kind, detail: 'multiple changes' };
  }
  return { kind: 'watch-git-state', detail: `${current.kind}, ${next.kind}` };
}

function sourceWatchChangeKind(event: string): ProjectInputChangeKind | undefined {
  if (event === 'add') return 'add';
  if (event === 'change') return 'change';
  if (event === 'unlink') return 'delete';
  return undefined;
}

function mergeProjectInputChangeKind(
  previous: ProjectInputChangeKind | undefined,
  next: ProjectInputChangeKind,
): ProjectInputChangeKind | null {
  if (!previous) return next;
  if (previous === 'add') return next === 'delete' ? null : 'add';
  if (previous === 'delete') return next === 'add' ? 'change' : next;
  return next;
}

function isFileDescriptorLimitError(error: unknown): boolean {
  return (
    (error instanceof Error && 'code' in error && error.code === 'EMFILE') ||
    String(error).includes('EMFILE: too many open files')
  );
}

function isSourceWatcherFallbackError(error: unknown): boolean {
  return error instanceof RecursiveSourceWatchError || isFileDescriptorLimitError(error);
}

interface WatchGitLayout {
  gitDir: string;
  indexPath: string;
}

const GIT_OBJECT_ID = /^[0-9a-f]{40,64}$/i;

export function isCheapIgnoredWatchPath(relativePath: string, cacheRelativePath?: string): boolean {
  if (relativePath === '.git' || relativePath.startsWith('.git/')) return true;
  if (
    relativePath === 'node_modules' ||
    relativePath.startsWith('node_modules/') ||
    relativePath.endsWith('/node_modules') ||
    relativePath.includes('/node_modules/')
  ) {
    return true;
  }
  return (
    cacheRelativePath !== undefined &&
    (relativePath === cacheRelativePath || relativePath.startsWith(`${cacheRelativePath}/`))
  );
}

export function resolveWatchGitLayout(projectRoot: string): WatchGitLayout | null {
  const marker = join(projectRoot, '.git');
  try {
    const stats = lstatSync(marker);
    let gitDir: string;
    if (stats.isDirectory()) {
      gitDir = marker;
    } else if (stats.isFile()) {
      const match = /^gitdir:\s*(.+)\s*$/m.exec(readSmallArtifactText(marker, 'Git directory marker'));
      if (!match?.[1]) return null;
      const rawGitDir = match[1].trim();
      gitDir = isAbsolute(rawGitDir) ? rawGitDir : resolve(projectRoot, rawGitDir);
    } else {
      return null;
    }
    if (!existsSync(gitDir)) return null;
    return { gitDir, indexPath: join(gitDir, 'index') };
  } catch {
    return null;
  }
}

export function readWatchGitHeadOid(gitDir: string): string | undefined {
  let head: string;
  try {
    head = readSmallArtifactText(join(gitDir, 'HEAD'), 'Git HEAD').trim();
  } catch {
    return undefined;
  }
  if (GIT_OBJECT_ID.test(head)) return head.toLowerCase();
  const ref = /^ref:\s*(.+)$/.exec(head)?.[1]?.trim();
  if (!ref) return undefined;
  const commonDir = readGitCommonDir(gitDir);
  return readGitRefOid(gitDir, ref) ?? readGitRefOid(commonDir, ref) ?? readPackedGitRefOid(commonDir, ref);
}

function readGitCommonDir(gitDir: string): string {
  try {
    const raw = readSmallArtifactText(join(gitDir, 'commondir'), 'Git common-directory marker').trim();
    if (!raw) return gitDir;
    return isAbsolute(raw) ? raw : resolve(gitDir, raw);
  } catch {
    return gitDir;
  }
}

function readGitRefOid(directory: string, ref: string): string | undefined {
  try {
    const oid = readSmallArtifactText(join(directory, ref), 'Git reference').trim();
    return GIT_OBJECT_ID.test(oid) ? oid.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function readPackedGitRefOid(commonDir: string, ref: string): string | undefined {
  try {
    for (const line of readSmallArtifactText(join(commonDir, 'packed-refs'), 'Git packed references').split('\n')) {
      if (line.startsWith('#') || line.startsWith('^')) continue;
      const separator = line.indexOf(' ');
      if (separator === -1) continue;
      const oid = line.slice(0, separator);
      if (line.slice(separator + 1).trim() === ref && GIT_OBJECT_ID.test(oid)) return oid.toLowerCase();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function gitStateFromIndexPath(head: string | undefined, indexPath: string): GitStateSnapshot {
  const snapshot: GitStateSnapshot = { head, indexPath };
  try {
    const indexStat = statSync(indexPath);
    snapshot.indexMtimeMs = indexStat.mtimeMs;
    snapshot.indexSize = indexStat.size;
  } catch {
    snapshot.indexMtimeMs = undefined;
    snapshot.indexSize = undefined;
  }
  return snapshot;
}

function localCacheWatchPath(projectRoot: string, cacheDir: string): string | undefined {
  const relativePath = relative(projectRoot, cacheDir).replaceAll('\\', '/');
  if (!relativePath || relativePath === '..' || relativePath.startsWith('../')) return undefined;
  return relativePath;
}

function positiveDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function resolveWatchInputLanguages(languages: readonly SupportedLanguage[] | undefined): readonly SupportedLanguage[] {
  return languages && languages.length > 0 ? [...languages] : SUPPORTED_LANGUAGES;
}

function refreshWatchInputLanguages(watcher: Watcher, projectRoot: string): void {
  try {
    const state = watcherInputState(watcher);
    state.config = loadProjectConfig(projectRoot);
    state.languages = resolveWatchInputLanguages(state.config.languages);
  } catch {
    watcherInputState(watcher).languages = SUPPORTED_LANGUAGES;
  }
}

function scopedProjectInputChangeKind(
  watcher: Watcher,
  event: string,
  path: string,
): ProjectInputChangeKind | null | undefined {
  const state = watcherInputState(watcher);
  const inputKind = classifyProjectInputPath(path, state.languages);
  if (inputKind === 'other') return null;

  const changeKind = sourceWatchChangeKind(event);
  if (path === '.scipquery.json' || isTypeScriptProjectConfigPath(path)) {
    // Scope-changing inputs stay conservative until the accepted generation
    // publishes its new exact input set.
    state.typeScriptInputPaths = null;
    return changeKind;
  }
  if (!isTypeScriptFamilyWatchSource(path, state.languages)) return changeKind;

  const scopedPaths = state.typeScriptInputPaths;
  if (!scopedPaths) return changeKind;
  const previouslyInScope = scopedPaths.has(path);
  if (changeKind !== 'add') return previouslyInScope ? changeKind : null;
  if (previouslyInScope) {
    // Native recursive watching reports an atomic replacement as a rename.
    // Preserve it as a modification when the accepted input already exists.
    return 'change';
  }

  const refreshedPaths = refreshLiveTypeScriptInputScope(watcher);
  if (!refreshedPaths) return changeKind;
  return refreshedPaths.has(path) ? 'add' : null;
}

function refreshPublishedTypeScriptInputScope(watcher: Watcher): void {
  const state = watcherInputState(watcher);
  if (!state.languages.includes('typescript')) {
    state.typeScriptInputPaths = null;
    return;
  }
  const published = readPublishedTypeScriptInputPaths(state.projectRoot, state.config, state.languages);
  state.typeScriptInputPaths = published ?? refreshLiveTypeScriptInputScope(watcher);
}

function refreshLiveTypeScriptInputScope(watcher: Watcher): ReadonlySet<string> | null {
  const state = watcherInputState(watcher);
  if (!state.languages.includes('typescript')) {
    state.typeScriptInputPaths = null;
    return null;
  }
  try {
    const typeScript = state.config.indexer?.typescript;
    const paths = typeScriptProjectInputPaths(state.projectRoot, typeScript?.projectMode, typeScript?.projects);
    state.typeScriptInputPaths = paths;
    return paths;
  } catch {
    state.typeScriptInputPaths = null;
    return null;
  }
}

function isTypeScriptFamilyWatchSource(path: string, languages: readonly SupportedLanguage[]): boolean {
  if (!languages.includes('typescript')) return false;
  const kind = classifyProjectInputPath(path, ['typescript', 'javascript']);
  return kind === 'source' || kind === 'ambient';
}

function readPublishedTypeScriptInputPaths(
  projectRoot: string,
  config: ProjectConfig,
  languages: readonly SupportedLanguage[],
): ReadonlySet<string> | null {
  try {
    const decoded = decodeReindexMetadata(
      readSmallArtifactText(resolveIndexStoragePaths(projectRoot, config).metaPath, 'reindex metadata'),
    );
    if (decoded.kind !== 'supported' && decoded.kind !== 'legacy') return null;
    const snapshot = projectInputSnapshotOrNull(decoded.metadata.fingerprint);
    if (!snapshot || !watchScopeConfigurationMatches(snapshot, languages, config)) return null;
    return new Set(snapshot.files.map((file) => file.path));
  } catch {
    return null;
  }
}

function watchScopeConfigurationMatches(
  snapshot: NonNullable<ReturnType<typeof projectInputSnapshotOrNull>>,
  languages: readonly SupportedLanguage[],
  config: ProjectConfig,
): boolean {
  const expected = normalizeProjectInputFingerprintConfiguration(languages, {
    pnpmWorkspaces: config.indexer?.typescript?.pnpmWorkspaces,
    typescriptProjectMode: config.indexer?.typescript?.projectMode,
    typescriptProjects: config.indexer?.typescript?.projects,
    clojureConfigPath: config.indexer?.clojure?.configPath,
  });
  return (
    snapshot.version === expected.version &&
    JSON.stringify([...snapshot.languages].sort()) === JSON.stringify(expected.languages) &&
    snapshot.pnpmWorkspaces === expected.pnpmWorkspaces &&
    snapshot.typescriptProjectMode === expected.typescriptProjectMode &&
    JSON.stringify([...snapshot.typescriptProjects].sort()) === JSON.stringify(expected.typescriptProjects) &&
    snapshot.clojureConfigPath === expected.clojureConfigPath
  );
}

function readChangedGitPaths(
  projectRoot: string,
  gitReader: GitReader,
  previous: GitStateSnapshot,
  next: GitStateSnapshot,
  previousStagedIndexEntries: ReadonlyMap<string, string> | null,
  nextStagedIndexEntries: ReadonlyMap<string, string> | null,
  headChanged: boolean,
  indexChanged: boolean,
): string[] | null {
  const paths = new Set<string>();
  if (headChanged) {
    if (!previous.head || !next.head) return null;
    const result = gitReader.runResult(projectRoot, [
      'diff',
      '--name-only',
      '-z',
      '--no-renames',
      '--relative',
      previous.head,
      next.head,
      '--',
    ]);
    if (result.kind !== 'success') return null;
    for (const path of parseNulPaths(result.output)) paths.add(path);
  }
  if (indexChanged) {
    if (previousStagedIndexEntries === null || nextStagedIndexEntries === null) return null;
    for (const path of changedMapKeys(previousStagedIndexEntries, nextStagedIndexEntries)) paths.add(path);
  }
  return [...paths].sort();
}

function readStagedIndexEntries(projectRoot: string, gitReader: GitReader): ReadonlyMap<string, string> | null {
  const result = gitReader.runResult(projectRoot, [
    'diff',
    '--cached',
    '--raw',
    '-z',
    '--no-renames',
    '--relative',
    '--',
  ]);
  return result.kind === 'success' ? parseRawGitEntries(result.output) : null;
}

function parseNulPaths(output: string): string[] {
  return output.split('\0').filter((path) => path.length > 0);
}

function parseRawGitEntries(output: string): ReadonlyMap<string, string> | null {
  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  if (fields.length % 2 !== 0) return null;
  const entries = new Map<string, string>();
  for (let index = 0; index < fields.length; index += 2) {
    const signature = fields[index]!;
    const path = fields[index + 1]!;
    if (!signature.startsWith(':') || !path) return null;
    entries.set(path, signature);
  }
  return entries;
}

function changedMapKeys(previous: ReadonlyMap<string, string>, next: ReadonlyMap<string, string>): string[] {
  const paths = new Set([...previous.keys(), ...next.keys()]);
  return [...paths].filter((path) => previous.get(path) !== next.get(path));
}

function gitChangeDetail(fallback: string, changedPaths: readonly string[] | null): string {
  if (changedPaths === null) return `${fallback}; changed paths unavailable`;
  if (changedPaths.length === 0) return fallback;
  if (changedPaths.length === 1) return changedPaths[0]!;
  return `${changedPaths.length} compiler inputs changed`;
}
