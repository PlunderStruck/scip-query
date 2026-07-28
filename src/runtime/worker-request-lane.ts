export interface RequestWorkerLike {
  postMessage(value: unknown): void;
  on(event: 'message', listener: (value: unknown) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  terminate(): Promise<number>;
}

export interface WorkerLaneRequest<Payload> {
  requestId: string;
  deadlineAtMs: number;
  payload: Payload;
}

export interface WorkerLaneResponse<Result, Status> {
  kind: 'response';
  requestId: string;
  ok: boolean;
  result?: Result;
  error?: string;
  status: Status;
}

export interface WorkerRequestLaneOptions<Payload, Result, Status> {
  name: string;
  createWorker(): RequestWorkerLike;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  onComplete(request: WorkerLaneRequest<Payload>, result: Result, status: Status): void;
  onReject(request: WorkerLaneRequest<Payload>, reason: string, status?: Status): void;
  onStatus(status: Status): void;
  onFatal(error: Error): void;
}

interface ActiveWorkerRequest<Payload> {
  request: WorkerLaneRequest<Payload>;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Own one persistent Worker and at most one request. Admission stays closed
 * from a timeout or Worker failure until termination has completed.
 */
export class WorkerRequestLane<Payload, Result, Status> {
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private worker: RequestWorkerLike | null = null;
  private active: ActiveWorkerRequest<Payload> | null = null;
  private activeFailure: Promise<void> | null = null;
  private terminating: Promise<boolean> | null = null;
  private closed = false;
  private workerGeneration = 0;

  constructor(private readonly options: WorkerRequestLaneOptions<Payload, Result, Status>) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  canAccept(): boolean {
    return !this.closed && this.active === null && this.terminating === null;
  }

  start(request: WorkerLaneRequest<Payload>): boolean {
    if (!this.canAccept()) return false;
    if (request.deadlineAtMs < this.now()) {
      try {
        this.options.onReject(request, `${this.options.name} request expired before processing.`);
      } catch (error) {
        this.closed = true;
        this.options.onFatal(asError(error));
      }
      return true;
    }
    const worker = this.ensureWorker();
    const delayMs = Math.max(1, Math.min(2_147_483_647, request.deadlineAtMs - this.now()));
    const timer = this.setTimer(() => {
      void this.failActiveAfterTermination(`${this.options.name} request exceeded its deadline.`);
    }, delayMs);
    this.active = { request, timer };
    try {
      worker.postMessage({ kind: 'request', ...request });
    } catch (error) {
      void this.failActiveAfterTermination(errorMessage(error));
    }
    return true;
  }

  async close(reason = `${this.options.name} service is shutting down.`): Promise<void> {
    this.closed = true;
    if (this.active) {
      await this.failActiveAfterTermination(reason);
      return;
    }
    await this.terminateWorker();
  }

  private ensureWorker(): RequestWorkerLike {
    if (this.worker) return this.worker;
    const worker = this.options.createWorker();
    const generation = ++this.workerGeneration;
    worker.on('message', (message) => this.handleMessage(generation, message));
    worker.on('error', (error) => {
      if (generation !== this.workerGeneration) return;
      void this.failActiveAfterTermination(`${this.options.name} worker failed: ${error.message}`);
    });
    worker.on('exit', (code) => {
      if (generation !== this.workerGeneration || this.terminating) return;
      this.worker = null;
      if (this.active) {
        void this.failActiveAfterTermination(`${this.options.name} worker exited unexpectedly with code ${code}.`);
      }
    });
    this.worker = worker;
    return worker;
  }

  private handleMessage(generation: number, value: unknown): void {
    if (generation !== this.workerGeneration || this.closed || !this.active) return;
    if (!isWorkerLaneResponse<Result, Status>(value)) {
      void this.failActiveAfterTermination(`${this.options.name} worker returned an invalid response.`);
      return;
    }
    if (value.requestId !== this.active.request.requestId) {
      void this.failActiveAfterTermination(`${this.options.name} worker returned a mismatched request identity.`);
      return;
    }
    if (this.now() > this.active.request.deadlineAtMs) {
      void this.failActiveAfterTermination(`${this.options.name} request expired while it was processing.`);
      return;
    }
    const active = this.active;
    try {
      this.options.onStatus(value.status);
      if (value.ok) {
        this.options.onComplete(active.request, value.result as Result, value.status);
      } else {
        this.options.onReject(active.request, value.error ?? `${this.options.name} request failed.`, value.status);
      }
    } catch (error) {
      this.closed = true;
      this.clearTimer(active.timer);
      this.options.onFatal(asError(error));
      return;
    }
    this.releaseActive(active);
  }

  private async failActiveAfterTermination(reason: string): Promise<void> {
    if (this.activeFailure) {
      await this.activeFailure;
      return;
    }
    const active = this.active;
    if (!active) {
      await this.terminateWorker();
      return;
    }
    this.clearTimer(active.timer);
    const failure = (async (): Promise<void> => {
      const terminated = await this.terminateWorker();
      if (!terminated) return;
      try {
        this.options.onReject(active.request, reason);
      } catch (error) {
        this.closed = true;
        this.options.onFatal(asError(error));
        return;
      }
      this.releaseActive(active);
    })();
    this.activeFailure = failure;
    try {
      await failure;
    } finally {
      if (this.activeFailure === failure) this.activeFailure = null;
    }
  }

  private releaseActive(active: ActiveWorkerRequest<Payload>): void {
    if (this.active !== active) return;
    this.active = null;
    this.clearTimer(active.timer);
  }

  private async terminateWorker(): Promise<boolean> {
    if (this.terminating) {
      return this.terminating;
    }
    const worker = this.worker;
    if (!worker) return true;
    this.worker = null;
    const generation = ++this.workerGeneration;
    this.terminating = (async (): Promise<boolean> => {
      try {
        await worker.terminate();
        return true;
      } catch (error) {
        this.closed = true;
        this.options.onFatal(
          new Error(`${this.options.name} worker termination failed: ${errorMessage(error)}`, { cause: error }),
        );
        return false;
      } finally {
        if (generation === this.workerGeneration) this.terminating = null;
      }
    })();
    return this.terminating;
  }
}

function isWorkerLaneResponse<Result, Status>(value: unknown): value is WorkerLaneResponse<Result, Status> {
  if (!value || typeof value !== 'object') return false;
  const response = value as Partial<WorkerLaneResponse<Result, Status>>;
  return (
    response.kind === 'response' &&
    typeof response.requestId === 'string' &&
    typeof response.ok === 'boolean' &&
    'status' in response &&
    (response.ok ? 'result' in response : typeof response.error === 'string')
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
