import { fileURLToPath } from 'node:url';
import { BoundedProcessError, PROCESS_TIMEOUT_MS, runBoundedProcess } from '../platform/bounded-process.js';

/** One finite cleanup process, owned separately from the watcher's request-handling thread. */
export class RepositoryCacheMaintenance {
  private running: Promise<void> | undefined;
  private cancellation: AbortController | undefined;
  private closed = false;
  private cleanupFailure: Error | undefined;

  constructor(
    private readonly opts: {
      projectRoot: string;
      cliVersion: string;
      onError(error: Error): void;
      workerUrl?: URL;
      run?: typeof runBoundedProcess;
    },
  ) {}

  start(): void {
    if (this.closed || this.running || this.cleanupFailure) return;
    const cancellation = new AbortController();
    this.cancellation = cancellation;
    this.running = this.sweep(cancellation.signal)
      .catch((cause: unknown) => {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        if (error instanceof BoundedProcessError && !error.reaped) this.cleanupFailure = error;
        if (!cancellation.signal.aborted) {
          try {
            this.opts.onError(error);
          } catch (reportError) {
            this.cleanupFailure = reportError instanceof Error ? reportError : new Error(String(reportError));
          }
        }
      })
      .finally(() => {
        this.running = undefined;
      });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.cancellation?.abort();
    await this.running;
    if (this.cleanupFailure) throw this.cleanupFailure;
  }

  private async sweep(signal: AbortSignal): Promise<void> {
    const result = await (this.opts.run ?? runBoundedProcess)({
      command: process.execPath,
      args: [
        '--max-old-space-size=512',
        fileURLToPath(this.opts.workerUrl ?? new URL('./repository-cache-worker.js', import.meta.url)),
        this.opts.projectRoot,
        this.opts.cliVersion,
      ],
      label: 'repository cache maintenance',
      timeoutMs: PROCESS_TIMEOUT_MS.analysis,
      maxStdoutBytes: 8 * 1024,
      maxStderrBytes: 8 * 1024,
      signal,
    });
    if (result.status !== 0)
      throw new Error(
        `Repository cache maintenance exited with ${result.status ?? result.signal}: ${result.stderr.trim()}`,
      );
  }
}
