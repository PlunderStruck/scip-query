import { fork } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import ignore from 'ignore';
import type {
  RefreshTrigger,
  WatcherStatus,
  ProjectConfig,
  SupportedLanguage,
  TypeScriptProjectMode,
} from '../domain/types.js';
import { resolveIndexStoragePaths } from '../platform/cache-layout.js';
import { loadProjectConfig, resolveWatchConfig } from './config.js';
import { createGitignoreFilter } from '../source/primitives/gitignore-filter.js';
import { gitOutput, resolveGitPath } from '../platform/git-worktree.js';
import { REINDEX_ACTIVITY_FILE } from '../reindex/reindex-activity.js';

export interface WatcherOptions {
  projectRoot: string;
  config: ProjectConfig;
  languages?: SupportedLanguage[];
  onStatus?: (status: WatcherStatus) => void;
  onReindexComplete?: (durationMs: number) => boolean | void;
  onRefreshSuppressed?: (trigger: RefreshTrigger) => void;
  onError?: (error: Error) => void;
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
 *  - Dirty flag: changes during reindex schedule ONE follow-up
 *  - Cooldown: minimum interval between reindex completions
 *  - Atomic publish: the reindexer writes temp artifacts, then promotes them
 */
export class Watcher {
  private projectRoot: string;
  private config: ProjectConfig;
  private watchConfig: Required<NonNullable<ProjectConfig['watch']>>;
  private languages?: SupportedLanguage[];
  private pnpmWorkspaces: boolean;
  private typescriptProjectMode?: TypeScriptProjectMode;
  private typescriptProjects?: string[];
  private clojureConfigPath?: string;
  private indexerConcurrency?: number;

  private onStatus: (status: WatcherStatus) => void;
  private onReindexComplete: (durationMs: number) => boolean | void;
  private onRefreshSuppressed: (trigger: RefreshTrigger) => void;
  private onError: (error: Error) => void;

  // State machine
  private status: WatcherStatus = { state: 'idle' };
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private changedFiles = 0;
  private pendingTrigger: RefreshTrigger | null = null;
  private reindexInFlight = false;
  private lastReindexEnd = 0;

  // Chokidar maintains the platform-specific subscriptions beneath each root.
  private fsWatchers: FSWatcher[] = [];
  private sourcePollingFallbackStarted = false;
  private gitPollTimer: ReturnType<typeof setInterval> | null = null;
  private lastGitState: GitStateSnapshot | null = null;
  private gitignoreFilter: ReturnType<typeof createGitignoreFilter>;
  private extraIgnore: ReturnType<typeof ignore>;
  private stopped = false;

  constructor(opts: WatcherOptions) {
    this.projectRoot = opts.projectRoot;
    this.config = opts.config;
    this.watchConfig = resolveWatchConfig(opts.config);
    this.languages = opts.languages;
    this.pnpmWorkspaces = opts.config.indexer?.typescript?.pnpmWorkspaces ?? false;
    this.typescriptProjectMode = opts.config.indexer?.typescript?.projectMode;
    this.typescriptProjects = opts.config.indexer?.typescript?.projects;
    this.clojureConfigPath = opts.config.indexer?.clojure?.configPath;
    this.indexerConcurrency = opts.config.indexerConcurrency;

    this.onStatus = opts.onStatus ?? (() => {});
    this.onReindexComplete = opts.onReindexComplete ?? (() => {});
    this.onRefreshSuppressed = opts.onRefreshSuppressed ?? (() => {});
    this.onError = opts.onError ?? ((e) => console.error(e.message));

    this.gitignoreFilter = createGitignoreFilter(opts.projectRoot);
    this.extraIgnore = ignore();
    if (this.watchConfig.ignore.length > 0) {
      this.extraIgnore.add(this.watchConfig.ignore);
    }
  }

  /** Start watching for file changes */
  // scip-query: ignore-extract — this wires the watcher lifecycle: initial
  // status, chokidar subscription, debounce handling, and close semantics are
  // one runtime boundary.
  start(): void {
    this.stopped = false;
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
  stop(): void {
    this.stopped = true;
    for (const w of this.fsWatchers) void w.close();
    this.fsWatchers = [];
    this.clearDebounceTimer();
    this.clearCooldownTimer();
    this.clearGitPollTimer();
    this.setStatus({ state: 'idle' });
  }

  /** Request a refresh through the same single-flight/coalescing state machine used by file events. */
  requestRefresh(trigger: RefreshTrigger, opts: { immediate?: boolean } = {}): void {
    if (!opts.immediate || this.reindexInFlight || this.status.state === 'cooldown') {
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
    const watcher = watch(this.projectRoot, {
      ignoreInitial: true,
      ignored: (path, stats) => this.isIgnoredWatchPath(path, stats?.isDirectory() ?? false),
      usePolling,
      ...(usePolling ? { interval: 500, binaryInterval: 1_000 } : {}),
    });
    watcher.on('all', (_event, path) => {
      if (!this.stopped) this.handleFileChange(path);
    });
    watcher.on('error', (error) => this.handleSourceWatcherError(watcher, error, usePolling));
    this.fsWatchers.push(watcher);
  }

  private handleSourceWatcherError(watcher: FSWatcher, error: unknown, usePolling: boolean): void {
    if (usePolling || this.sourcePollingFallbackStarted || !isFileDescriptorLimitError(error) || this.stopped) {
      this.onError(new Error(`Failed to watch ${this.projectRoot}: ${String(error)}`));
      return;
    }

    this.sourcePollingFallbackStarted = true;
    this.fsWatchers = this.fsWatchers.filter((candidate) => candidate !== watcher);
    void watcher.close();
    try {
      this.startSourceWatcher(true);
    } catch (fallbackError) {
      this.onError(new Error(`Failed to watch ${this.projectRoot}: ${String(fallbackError)}`));
    }
  }

  private isIgnoredWatchPath(path: string, isDirectory: boolean): boolean {
    const relativePath = this.relativeWatchPath(path);
    if (!relativePath) return false;

    const candidate = isDirectory ? `${relativePath}/` : relativePath;
    if (candidate === '.git/' || candidate.startsWith('.git/')) return true;
    return this.gitignoreFilter.isIgnored(candidate) || this.extraIgnore.ignores(candidate);
  }

  private handleFileChange(filename: string): void {
    // Filter: skip gitignored files and extra ignore patterns
    const rel = this.relativeWatchPath(filename);
    if (!rel || rel === '..' || rel.startsWith('../')) return;
    if (rel === '.git' || rel.startsWith('.git/')) return;
    if (this.gitignoreFilter.isIgnored(rel)) return;
    if (this.extraIgnore.ignores(rel)) return;

    // Skip the index files themselves
    if (
      rel.endsWith('index.db') ||
      rel.endsWith('index.scip') ||
      rel.endsWith('index.db.tmp') ||
      rel.endsWith(REINDEX_ACTIVITY_FILE) ||
      rel.endsWith(`${REINDEX_ACTIVITY_FILE}.previous`)
    ) {
      return;
    }

    this.scheduleReindex({ kind: 'watch-source', detail: rel });
  }

  private relativeWatchPath(path: string): string {
    const absolutePath = isAbsolute(path) ? path : join(this.projectRoot, path);
    return relative(this.projectRoot, absolutePath).replaceAll('\\', '/');
  }

  private scheduleReindex(trigger: RefreshTrigger): void {
    this.pendingTrigger = mergeRefreshTrigger(this.pendingTrigger, trigger);
    this.changedFiles++;

    if (this.reindexInFlight) {
      // Reindex is running — just mark dirty, don't schedule anything
      this.dirty = true;
      this.setStatus({
        state: 'indexing',
        startedAt: (this.status as { startedAt: number }).startedAt,
      });
      return;
    }

    if (this.status.state === 'cooldown') {
      // In cooldown — mark dirty, the cooldown handler will pick it up
      this.dirty = true;
      this.setStatus({ state: 'cooldown', until: (this.status as { until: number }).until, dirty: true });
      return;
    }

    // Reset the debounce timer — every new change pushes the trigger out
    this.clearDebounceTimer();

    const reindexAt = Date.now() + this.watchConfig.debounceMs;
    this.setStatus({ state: 'waiting', changedFiles: this.changedFiles, reindexAt });

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.triggerReindex();
    }, this.watchConfig.debounceMs);
  }

  // scip-query: ignore-extract — this method is the watcher's state machine:
  // cooldown, in-flight state, retry scheduling, and error recovery must stay
  // visible together.
  private triggerReindex(): void {
    if (this.reindexInFlight || this.stopped) return;

    // Check cooldown
    const timeSinceLastReindex = Date.now() - this.lastReindexEnd;
    if (this.lastReindexEnd > 0 && timeSinceLastReindex < this.watchConfig.cooldownMs) {
      const remaining = this.watchConfig.cooldownMs - timeSinceLastReindex;
      this.dirty = true;
      const until = Date.now() + remaining;
      this.setStatus({ state: 'cooldown', until, dirty: true });

      this.cooldownTimer = setTimeout(() => {
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
    const startedAt = Date.now();
    this.setStatus({ state: 'indexing', startedAt });

    // Run reindex in a child process so it doesn't block the watcher
    this.runReindex(trigger)
      .then((durationMs) => {
        this.reindexInFlight = false;
        this.lastReindexEnd = Date.now();
        let completedIndexIsFresh = false;
        try {
          completedIndexIsFresh = this.onReindexComplete(durationMs) === true;
        } catch (error) {
          this.onError(error instanceof Error ? error : new Error(String(error)));
        }

        if (this.dirty && !this.stopped) {
          if (completedIndexIsFresh) {
            const suppressedTrigger = this.pendingTrigger ?? { kind: 'unknown' };
            this.dirty = false;
            this.changedFiles = 0;
            this.pendingTrigger = null;
            this.onRefreshSuppressed(suppressedTrigger);
            this.setStatus({ state: 'idle' });
            return;
          }
          // Changes arrived during reindex — enter cooldown then reindex again
          const until = Date.now() + this.watchConfig.cooldownMs;
          this.setStatus({ state: 'cooldown', until, dirty: true });

          this.cooldownTimer = setTimeout(() => {
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
        this.lastReindexEnd = Date.now();
        this.onError(err instanceof Error ? err : new Error(String(err)));
        this.setStatus({ state: 'idle' });
      });
  }

  /**
   * Run the reindex in a forked child process.
   * The child process uses the reindexer's own atomic publish path.
   */
  private runReindex(trigger: RefreshTrigger): Promise<number> {
    return new Promise((resolve, reject) => {
      const start = Date.now();

      const loadedConfig = loadProjectConfig(this.projectRoot);
      const latestConfig = Object.keys(loadedConfig).length > 0 ? loadedConfig : this.config;
      const latestIndexPaths = resolveIndexStoragePaths(this.projectRoot, latestConfig);
      const latestTypeScript = latestConfig.indexer?.typescript;
      const latestClojure = latestConfig.indexer?.clojure;
      // scip-query: process-lifetime-reviewed -- this reindex worker is owned
      // by the watch job state machine; RES-02 hardens its drain/shutdown path.
      const child = fork(new URL('./reindex-worker.js', import.meta.url).pathname, [], {
        detached: true,
        env: {
          ...process.env,
          SCIP_REINDEX_PROJECT_ROOT: this.projectRoot,
          SCIP_REINDEX_OUTPUT_SCIP: latestIndexPaths.indexPath,
          SCIP_REINDEX_OUTPUT_DB: latestIndexPaths.dbPath,
          SCIP_REINDEX_LANGUAGES: (latestConfig.languages ?? this.languages)?.join(',') ?? '',
          SCIP_REINDEX_INDEXER_CONCURRENCY: String(latestConfig.indexerConcurrency ?? this.indexerConcurrency ?? ''),
          SCIP_REINDEX_PNPM_WORKSPACES: (latestTypeScript?.pnpmWorkspaces ?? this.pnpmWorkspaces) ? '1' : '',
          SCIP_REINDEX_TYPESCRIPT_CONFIG: JSON.stringify({
            projectMode: latestTypeScript?.projectMode ?? this.typescriptProjectMode,
            projects: latestTypeScript?.projects ?? this.typescriptProjects ?? [],
          }),
          SCIP_REINDEX_CLOJURE_CONFIG_PATH: latestClojure?.configPath ?? this.clojureConfigPath ?? '',
          SCIP_REINDEX_TRIGGER_KIND: trigger.kind,
          SCIP_REINDEX_TRIGGER_DETAIL: trigger.detail ?? '',
          SCIP_REINDEX_PROCESS_GROUP_LEADER: '1',
        },
        stdio: 'pipe',
      });

      child.on('exit', (code) => {
        if (code === 0) {
          resolve(Date.now() - start);
        } else {
          reject(new Error(`Reindex worker exited with code ${code}`));
        }
      });

      child.on('error', reject);
    });
  }

  private setStatus(status: WatcherStatus): void {
    this.status = status;
    this.onStatus(status);
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private clearCooldownTimer(): void {
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
  }

  private startGitStatePolling(): void {
    this.lastGitState = this.readGitState();
    if (!this.lastGitState) return;
    this.gitPollTimer = setInterval(() => this.pollGitState(), this.watchConfig.gitPollMs);
    this.gitPollTimer.unref?.();
  }

  private pollGitState(): void {
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

    if (headChanged && indexChanged) {
      this.scheduleReindex({ kind: 'watch-git-state', detail: 'HEAD and index changed' });
    } else if (headChanged) {
      this.scheduleReindex({ kind: 'watch-git-head', detail: 'HEAD changed' });
    } else if (indexChanged) {
      this.scheduleReindex({ kind: 'watch-git-index', detail: next.indexPath ?? 'index changed' });
    }
  }

  private readGitState(): GitStateSnapshot | null {
    const rawIndexPath = gitOutput(this.projectRoot, ['rev-parse', '--git-path', 'index']);
    if (!rawIndexPath) return null;
    const indexPath = resolveGitPath(this.projectRoot, rawIndexPath);

    const snapshot: GitStateSnapshot = {
      head: gitOutput(this.projectRoot, ['rev-parse', '--verify', 'HEAD']),
      indexPath,
    };

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

  private clearGitPollTimer(): void {
    if (this.gitPollTimer) {
      clearInterval(this.gitPollTimer);
      this.gitPollTimer = null;
    }
  }
}

function mergeRefreshTrigger(current: RefreshTrigger | null, next: RefreshTrigger): RefreshTrigger {
  if (!current) return next;
  if (current.kind === next.kind) {
    if (current.detail === next.detail) return current;
    return { kind: current.kind, detail: 'multiple changes' };
  }
  return { kind: 'watch-git-state', detail: `${current.kind}, ${next.kind}` };
}

function isFileDescriptorLimitError(error: unknown): boolean {
  return (
    (error instanceof Error && 'code' in error && error.code === 'EMFILE') ||
    String(error).includes('EMFILE: too many open files')
  );
}
