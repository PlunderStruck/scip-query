import { describe, expect, it } from 'vitest';
import {
  WorkerRequestLane,
  decodeWorkerLaneResponse,
  type RequestWorkerLike,
  type WorkerLaneResponse,
} from '../../src/runtime/worker-request-lane.js';
import { runWatchServiceLoopIteration } from '../../src/runtime/watch-server.js';

interface Payload {
  value: string;
}

interface Status {
  requests: number;
}

describe('WorkerRequestLane', () => {
  it('decodes only state-complete Worker responses', () => {
    expect(
      decodeWorkerLaneResponse<string, Status>({
        kind: 'response',
        requestId: 'one',
        ok: true,
        result: 'done',
        status: { requests: 1 },
      }),
    ).toMatchObject({ ok: true, result: 'done' });
    expect(
      decodeWorkerLaneResponse<string, Status>({
        kind: 'response',
        requestId: 'one',
        ok: false,
        error: 'failed',
        status: { requests: 1 },
      }),
    ).toMatchObject({ ok: false, error: 'failed' });
    expect(
      decodeWorkerLaneResponse<string, Status>({
        kind: 'response',
        requestId: 'one',
        ok: true,
        error: 'not a result',
        status: { requests: 1 },
      }),
    ).toBeNull();
    expect(
      decodeWorkerLaneResponse<string, Status>({
        kind: 'response',
        requestId: 'one',
        ok: false,
        status: { requests: 1 },
      }),
    ).toBeNull();
  });

  it('settles a request exactly once when a Worker repeats its response', () => {
    const worker = new FakeWorker();
    const completions: string[] = [];
    const rejections: string[] = [];
    const lane = createLane(worker, {
      onComplete: (_request, result) => completions.push(result),
      onReject: (_request, reason) => rejections.push(reason),
    });

    expect(lane.start(request('one'))).toBe(true);
    const response = success('one', 'done', 1);
    worker.emitMessage(response);
    worker.emitMessage(response);

    expect(completions).toEqual(['done']);
    expect(rejections).toEqual([]);
    expect(lane.canAccept()).toBe(true);
  });

  it('retains ownership and closes admission when completion settlement throws', async () => {
    const worker = new FakeWorker();
    const fatal: string[] = [];
    const rejections: string[] = [];
    const lane = createLane(worker, {
      onComplete: () => {
        throw new Error('durable completion failed');
      },
      onReject: (_request, reason) => rejections.push(reason),
      onFatal: (error) => fatal.push(error.message),
    });

    expect(lane.start(request('one'))).toBe(true);
    const response = success('one', 'done', 1);
    worker.emitMessage(response);
    worker.emitMessage(response);

    expect(fatal).toEqual(['durable completion failed']);
    expect(lane.canAccept()).toBe(false);
    expect(lane.start(request('replacement'))).toBe(false);

    await lane.close('service failed after completion settlement');
    expect(worker.terminateCalls).toBe(1);
    expect(rejections).toEqual(['service failed after completion settlement']);
    expect(lane.canAccept()).toBe(false);
  });

  it('retains ownership and retries rejection only during fail-stop shutdown', async () => {
    const worker = new FakeWorker();
    const fatal: string[] = [];
    const rejections: string[] = [];
    let rejectAttempts = 0;
    const lane = createLane(worker, {
      onReject: (_request, reason) => {
        rejectAttempts += 1;
        if (rejectAttempts === 1) throw new Error('durable rejection failed');
        rejections.push(reason);
      },
      onFatal: (error) => fatal.push(error.message),
    });

    expect(lane.start(request('one'))).toBe(true);
    worker.emitMessage(failure('one', 'worker could not answer', 1));
    worker.emitMessage(failure('one', 'duplicate response', 1));

    expect(fatal).toEqual(['durable rejection failed']);
    expect(rejectAttempts).toBe(1);
    expect(lane.canAccept()).toBe(false);

    await lane.close('service failed after rejection settlement');
    expect(worker.terminateCalls).toBe(1);
    expect(rejectAttempts).toBe(2);
    expect(rejections).toEqual(['service failed after rejection settlement']);
  });

  it('closes admission after timeout until Worker termination has joined', async () => {
    const first = new FakeWorker();
    const second = new FakeWorker();
    const termination = deferred<number>();
    first.termination = termination.promise;
    const workers = [first, second];
    const rejected: string[] = [];
    const rejectionObserved = deferred<void>();
    let timeout: (() => void) | undefined;
    const lane = new WorkerRequestLane<Payload, string, Status>({
      name: 'test lane',
      createWorker: () => workers.shift()!,
      setTimer: (callback) => {
        timeout = callback;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {},
      onComplete: () => {},
      onReject: (_request, reason) => {
        rejected.push(reason);
        rejectionObserved.resolve();
      },
      onStatus: () => {},
      onFatal: (error) => {
        throw error;
      },
    });

    expect(lane.start(request('first'))).toBe(true);
    timeout!();
    await Promise.resolve();
    expect(first.terminateCalls).toBe(1);
    expect(lane.canAccept()).toBe(false);
    expect(lane.start(request('too-early'))).toBe(false);
    expect(rejected).toEqual([]);

    termination.resolve(1);
    await rejectionObserved.promise;
    expect(rejected).toEqual(['test lane request exceeded its deadline.']);
    expect(lane.canAccept()).toBe(true);
    expect(lane.start(request('replacement'))).toBe(true);
    expect(second.posts).toHaveLength(1);
  });

  it('terminates an idle Worker after its idle TTL and admits a later request on a new Worker', async () => {
    const first = new FakeWorker();
    const second = new FakeWorker();
    const workers = [first, second];
    let idle: (() => void) | undefined;
    const lane = new WorkerRequestLane<Payload, string, Status>({
      name: 'test lane',
      createWorker: () => workers.shift()!,
      idleTtlMs: 30_000,
      setTimer: (callback, delayMs) => {
        if (delayMs === 30_000) idle = callback;
        return delayMs as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {},
      onComplete: () => {},
      onReject: () => {},
      onStatus: () => {},
      onFatal: (error) => {
        throw error;
      },
    });

    expect(lane.start(request('one'))).toBe(true);
    first.emitMessage(success('one', 'done', 1));
    expect(first.terminateCalls).toBe(0);
    expect(idle).toBeTypeOf('function');
    idle!();
    await first.termination;
    await Promise.resolve();
    expect(first.terminateCalls).toBe(1);
    expect(lane.canAccept()).toBe(true);
    expect(lane.start(request('two'))).toBe(true);
    expect(second.posts).toHaveLength(1);

    await lane.close();
  });

  it('joins termination before rejecting an active request during close', async () => {
    const worker = new FakeWorker();
    const termination = deferred<number>();
    worker.termination = termination.promise;
    const events: string[] = [];
    const lane = createLane(worker, {
      onReject: () => events.push('rejected'),
    });

    lane.start(request('active'));
    const closing = lane.close().then(() => events.push('closed'));
    await Promise.resolve();
    expect(events).toEqual([]);
    termination.resolve(1);
    await closing;

    expect(events).toEqual(['rejected', 'closed']);
    expect(lane.canAccept()).toBe(false);
  });

  it('lets the control loop poll and stop while both independent Workers remain blocked', async () => {
    const indexWorker = new FakeWorker();
    const semanticWorker = new FakeWorker();
    const indexLane = createLane(indexWorker);
    const semanticLane = createLane(semanticWorker);

    const iteration = await runWatchServiceLoopIteration(0, {
      processIndexRequests: () => (indexLane.start(request('index')) ? 1 : 0),
      processSemanticRequests: () => (semanticLane.start(request('semantic')) ? 1 : 0),
      afterMailboxPoll: () => {},
      shouldStop: () => true,
      wait: async () => {
        throw new Error('stopped iteration must not wait');
      },
    });

    expect(iteration.stopped).toBe(true);
    expect(indexWorker.posts).toHaveLength(1);
    expect(semanticWorker.posts).toHaveLength(1);
    await Promise.all([indexLane.close(), semanticLane.close()]);
  });

  it('fails closed without rejecting the claim when Worker termination cannot be joined', async () => {
    const worker = new FakeWorker();
    worker.termination = Promise.reject(new Error('termination unavailable'));
    const rejected: string[] = [];
    const fatal: string[] = [];
    const lane = new WorkerRequestLane<Payload, string, Status>({
      name: 'test lane',
      createWorker: () => worker,
      onComplete: () => {},
      onReject: (_request, reason) => rejected.push(reason),
      onStatus: () => {},
      onFatal: (error) => fatal.push(error.message),
    });

    lane.start(request('active'));
    await lane.close();

    expect(rejected).toEqual([]);
    expect(fatal).toEqual([expect.stringContaining('termination failed')]);
    expect(lane.canAccept()).toBe(false);
  });
});

function createLane(
  worker: FakeWorker,
  overrides: {
    onComplete?: (request: ReturnType<typeof request>, result: string, status: Status) => void;
    onReject?: (request: ReturnType<typeof request>, reason: string, status?: Status) => void;
    onFatal?: (error: Error) => void;
  } = {},
): WorkerRequestLane<Payload, string, Status> {
  return new WorkerRequestLane({
    name: 'test lane',
    createWorker: () => worker,
    onComplete: overrides.onComplete ?? (() => {}),
    onReject: overrides.onReject ?? (() => {}),
    onStatus: () => {},
    onFatal:
      overrides.onFatal ??
      ((error) => {
        throw error;
      }),
  });
}

function request(requestId: string) {
  return {
    requestId,
    deadlineAtMs: Date.now() + 60_000,
    payload: { value: requestId },
  };
}

function success(requestId: string, result: string, requests: number): WorkerLaneResponse<string, Status> {
  return { kind: 'response', requestId, ok: true, result, status: { requests } };
}

function failure(requestId: string, error: string, requests: number): WorkerLaneResponse<string, Status> {
  return { kind: 'response', requestId, ok: false, error, status: { requests } };
}

class FakeWorker implements RequestWorkerLike {
  readonly posts: unknown[] = [];
  terminateCalls = 0;
  termination: Promise<number> = Promise.resolve(0);
  private readonly messageListeners: Array<(value: unknown) => void> = [];
  private readonly errorListeners: Array<(error: Error) => void> = [];
  private readonly exitListeners: Array<(code: number) => void> = [];

  postMessage(value: unknown): void {
    this.posts.push(value);
  }

  on(event: 'message' | 'error' | 'exit', listener: ((value: unknown) => void) | ((error: Error) => void)): this {
    if (event === 'message') this.messageListeners.push(listener as (value: unknown) => void);
    else if (event === 'error') this.errorListeners.push(listener as (error: Error) => void);
    else this.exitListeners.push(listener as (code: number) => void);
    return this;
  }

  terminate(): Promise<number> {
    this.terminateCalls += 1;
    return this.termination;
  }

  emitMessage(value: unknown): void {
    for (const listener of this.messageListeners) listener(value);
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
