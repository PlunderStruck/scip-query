import { watch } from 'node:fs';
import { existsSync, renameSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fork } from 'node:child_process';
import ignore from 'ignore';
import type { WatcherStatus, ProjectConfig, SupportedLanguage } from './types.js';
import { resolveWatchConfig, resolveIndexPaths } from './config.js';
import { createGitignoreFilter } from './gitignore-filter.js';

export interface WatcherOptions {
  projectRoot: string;
  config: ProjectConfig;
  languages?: SupportedLanguage[];
  onStatus?: (status: WatcherStatus) => void;
  onReindexComplete?: (durationMs: number) => void;
  onError?: (error: Error) => void;
}

/**
 * File watcher that triggers single-flight background reindexing.
 *
 * Design:
 *  - Debounce: waits 30s (configurable) after the last file change
 *  - Single-flight: only one reindex runs at a time, never queued
 *  - Dirty flag: changes during reindex schedule ONE follow-up
 *  - Cooldown: minimum interval between reindex completions
 *  - Atomic swap: writes to index.db.tmp, renames on success
 */
export class Watcher {
  private projectRoot: string;
  private watchConfig: Required<NonNullable<ProjectConfig['watch']>>;
  private indexPaths: ReturnType<typeof resolveIndexPaths>;
  private languages?: SupportedLanguage[];
  private pnpmWorkspaces: boolean;

  private onStatus: (status: WatcherStatus) => void;
  private onReindexComplete: (durationMs: number) => void;
  private onError: (error: Error) => void;

  // State machine
  private status: WatcherStatus = { state: 'idle' };
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private changedFiles = 0;
  private reindexInFlight = false;
  private lastReindexEnd = 0;

  // fs.watch watchers (one per watched directory)
  private fsWatchers: ReturnType<typeof watch>[] = [];
  private gitignoreFilter: ReturnType<typeof createGitignoreFilter>;
  private extraIgnore: ReturnType<typeof ignore>;
  private stopped = false;

  constructor(opts: WatcherOptions) {
    this.projectRoot = opts.projectRoot;
    this.watchConfig = resolveWatchConfig(opts.config);
    this.indexPaths = resolveIndexPaths(opts.projectRoot, opts.config);
    this.languages = opts.languages;
    this.pnpmWorkspaces = opts.config.indexer?.typescript?.pnpmWorkspaces ?? false;

    this.onStatus = opts.onStatus ?? (() => {});
    this.onReindexComplete = opts.onReindexComplete ?? (() => {});
    this.onError = opts.onError ?? ((e) => console.error(e.message));

    this.gitignoreFilter = createGitignoreFilter(opts.projectRoot);
    this.extraIgnore = ignore();
    if (this.watchConfig.ignore.length > 0) {
      this.extraIgnore.add(this.watchConfig.ignore);
    }
  }

  /** Start watching for file changes */
  start(): void {
    this.stopped = false;
    this.setStatus({ state: 'idle' });

    // Use recursive fs.watch on the project root
    // This is supported on macOS (FSEvents) and Windows
    // On Linux, falls back to inotify (may need per-directory watchers for large trees)
    try {
      const watcher = watch(
        this.projectRoot,
        { recursive: true },
        (_event, filename) => {
          if (filename && !this.stopped) {
            this.handleFileChange(filename);
          }
        },
      );
      this.fsWatchers.push(watcher);
    } catch {
      this.onError(new Error(
        'Failed to start file watcher. On Linux, you may need to increase inotify limits: ' +
        'sysctl -w fs.inotify.max_user_watches=524288',
      ));
    }
  }

  /** Stop watching and clean up */
  stop(): void {
    this.stopped = true;
    for (const w of this.fsWatchers) w.close();
    this.fsWatchers = [];
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    this.setStatus({ state: 'idle' });
  }

  // ── Internal ─────────────────────────────────────────────

  private handleFileChange(filename: string): void {
    // Filter: skip gitignored files and extra ignore patterns
    const rel = relative(this.projectRoot, join(this.projectRoot, filename));
    if (this.gitignoreFilter.isIgnored(rel)) return;
    if (this.extraIgnore.ignores(rel)) return;

    // Skip the index files themselves
    if (filename.endsWith('index.db') || filename.endsWith('index.scip') ||
        filename.endsWith('index.db.tmp') || filename.endsWith('.scipquery.json')) {
      return;
    }

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
    if (this.debounceTimer) clearTimeout(this.debounceTimer);

    const reindexAt = Date.now() + this.watchConfig.debounceMs;
    this.setStatus({ state: 'waiting', changedFiles: this.changedFiles, reindexAt });

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.triggerReindex();
    }, this.watchConfig.debounceMs);
  }

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
    const startedAt = Date.now();
    this.setStatus({ state: 'indexing', startedAt });

    // Run reindex in a child process so it doesn't block the watcher
    this.runReindex()
      .then((durationMs) => {
        this.reindexInFlight = false;
        this.lastReindexEnd = Date.now();
        this.onReindexComplete(durationMs);

        if (this.dirty && !this.stopped) {
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
   * Writes to index.db.tmp, then atomically renames to index.db.
   */
  private runReindex(): Promise<number> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tmpDb = this.indexPaths.dbPath + '.tmp';
      const tmpScip = tempScipPath(this.indexPaths.indexPath);

      // Fork a child that runs the reindex
      const child = fork(
        new URL('./reindex-worker.js', import.meta.url).pathname,
        [],
        {
          env: {
            ...process.env,
            SCIP_REINDEX_PROJECT_ROOT: this.projectRoot,
            SCIP_REINDEX_OUTPUT_SCIP: tmpScip,
            SCIP_REINDEX_OUTPUT_DB: tmpDb,
            SCIP_REINDEX_LANGUAGES: this.languages?.join(',') ?? '',
            SCIP_REINDEX_PNPM_WORKSPACES: this.pnpmWorkspaces ? '1' : '',
          },
          stdio: 'pipe',
        },
      );

      child.on('exit', (code) => {
        if (code === 0) {
          // Atomic swap
          try {
            if (existsSync(tmpDb)) {
              renameSync(tmpDb, this.indexPaths.dbPath);
            }
            if (existsSync(tmpScip)) {
              renameSync(tmpScip, this.indexPaths.indexPath);
            }
            resolve(Date.now() - start);
          } catch (err) {
            reject(new Error(`Atomic swap failed: ${err}`));
          }
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
}

export function tempScipPath(indexPath: string): string {
  return indexPath.endsWith('.scip')
    ? indexPath.slice(0, -'.scip'.length) + '.tmp.scip'
    : indexPath + '.tmp.scip';
}
