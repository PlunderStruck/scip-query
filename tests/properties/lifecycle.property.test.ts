import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fc from 'fast-check';
import { it } from 'vitest';
import { WorkerRequestLane, type RequestWorkerLike } from '../../src/runtime/worker-request-lane.js';
import { runWatchServiceLifecycle } from '../../src/runtime/watch-server.js';
import { checkProperty, textArbitrary, PROPERTY_TIMEOUT } from './support.js';

class ControlledWorker extends EventEmitter implements RequestWorkerLike {
  terminations = 0;
  posts: unknown[] = [];
  readonly terminated = Promise.withResolvers<number>();
  postMessage(value: unknown): void {
    this.posts.push(value);
  }
  terminate(): Promise<number> {
    this.terminations += 1;
    return this.terminated.promise;
  }
}

const stepArbitrary = fc.record({
  outcome: fc.constantFrom('success', 'reject', 'malformed', 'mismatch', 'error', 'timeout', 'close'),
  value: textArbitrary,
  duplicates: fc.integer({ min: 0, max: 3 }),
});

it(
  'lifecycle: generated worker outcomes settle once and block admission until termination finishes',
  async () => {
    await checkProperty(
      'lifecycle',
      'worker-ownership-sequences',
      fc.asyncProperty(fc.array(stepArbitrary, { minLength: 1, maxLength: 6 }), async (steps) => {
        for (const [index, step] of steps.entries()) {
          const worker = new ControlledWorker();
          const completions: string[] = [];
          const rejections: string[] = [];
          const fatals: Error[] = [];
          const settled = Promise.withResolvers<void>();
          const timers = new Set<() => void>();
          let tick: (() => void) | undefined;
          const lane = new WorkerRequestLane<string, string, number>({
            name: 'property lane',
            createWorker: () => worker,
            now: () => 10,
            setTimer: (callback) => {
              timers.add(callback);
              tick = callback;
              return callback as unknown as ReturnType<typeof setTimeout>;
            },
            clearTimer: (timer) => {
              timers.delete(timer as unknown as () => void);
            },
            onComplete: (_, result) => {
              completions.push(result);
              settled.resolve();
            },
            onReject: (_, reason) => {
              rejections.push(reason);
              settled.resolve();
            },
            onStatus: () => {},
            onFatal: (error) => {
              fatals.push(error);
              settled.resolve();
            },
          });
          const request = { requestId: String(index), payload: step.value, deadlineAtMs: 100 };
          assert.equal(lane.start(request), true);
          assert.equal(lane.start({ ...request, requestId: 'second' }), false);
          assert.equal(worker.posts.length, 1);
          const response = {
            kind: 'response',
            requestId: request.requestId,
            ok: true,
            result: step.value,
            status: index,
          };
          let closing: Promise<void> | undefined;
          try {
            switch (step.outcome) {
              case 'success':
                worker.emit('message', response);
                break;
              case 'reject':
                worker.emit('message', {
                  kind: 'response',
                  requestId: request.requestId,
                  ok: false,
                  error: 'rejected',
                  status: index,
                });
                break;
              case 'malformed':
                worker.emit('message', { ...response, ok: false, error: 'contradictory result' });
                break;
              case 'mismatch':
                worker.emit('message', { ...response, requestId: 'unrelated' });
                break;
              case 'error':
                worker.emit('error', new Error('worker failed'));
                break;
              case 'timeout':
                tick!();
                break;
              case 'close':
                closing = lane.close('cancelled');
                break;
            }
            const direct = step.outcome === 'success' || step.outcome === 'reject';
            if (!direct) {
              assert.equal(lane.canAccept(), false);
              assert.equal(rejections.length, 0, 'ownership cannot be released before worker termination');
              worker.emit('message', response); // A response from the retiring generation must not settle success.
              assert.equal(completions.length, 0);
            }
            worker.terminated.resolve(0);
            await settled.promise;
            if (closing) await closing;
            for (let n = 0; n < step.duplicates; n += 1) worker.emit('message', response);
            assert.deepEqual(completions, step.outcome === 'success' ? [step.value] : []);
            assert.equal(rejections.length, step.outcome === 'success' ? 0 : 1);
            assert.deepEqual(fatals, []);
          } finally {
            worker.terminated.resolve(0);
            await lane.close();
          }
          assert.equal(worker.terminations, 1);
          assert.equal(timers.size, 0);
          assert.equal(lane.canAccept(), false);
          assert.equal(lane.start(request), false);
        }
      }),
    );
  },
  PROPERTY_TIMEOUT,
);

it(
  'lifecycle: watch startup and shutdown failures attempt all cleanup and preserve lock-release policy',
  async () => {
    await checkProperty(
      'lifecycle',
      'watch-finalization',
      fc.asyncProperty(
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.integer({ min: 0, max: 5 }),
        async (startupFails, laneFails, watcherFails, yields) => {
          const events: string[] = [];
          const stopSignal = () => {};
          const runtime: Parameters<typeof runWatchServiceLifecycle>[0] = {
            watcher: {
              start() {
                if (startupFails) throw new Error('startup failed');
              },
            },
            shutdown: {
              begin: async () => {
                for (let n = 0; n < yields; n += 1) await Promise.resolve();
                events.push('watcher');
                if (watcherFails) throw new Error('watcher failed');
                return { state: 'stopped' };
              },
            },
            stopSignal,
            initializeFreshness: () => null,
            markReady() {},
            recordActivity() {},
            persistState() {},
            requestRefresh() {},
            stopRequested: () => true,
            processIndexRequests: () => 0,
            processSemanticRequests: () => 0,
            afterMailboxPoll() {},
            shouldStop: () => true,
            wait: async () => {},
            closeLanes: async () => {
              events.push('lanes');
              if (laneFails) throw new Error('lanes failed');
            },
            mailboxFatalError: () => undefined,
            finalizeStopped: () => {
              events.push('released');
            },
            finalizeDegraded: (reasons) => {
              events.push('degraded');
              return new Error(reasons.join('; '));
            },
          };
          const operation = runWatchServiceLifecycle(runtime);
          if (startupFails || laneFails || watcherFails) await assert.rejects(operation);
          else await operation;
          assert.equal(events.filter((event) => event === 'watcher').length, 1);
          assert.equal(events.filter((event) => event === 'lanes').length, 1);
          assert.equal(events.at(-1), laneFails || watcherFails ? 'degraded' : 'released');
          assert.ok(!process.listeners('SIGINT').includes(stopSignal));
          assert.ok(!process.listeners('SIGTERM').includes(stopSignal));
        },
      ),
      'integration',
    );
  },
  PROPERTY_TIMEOUT,
);
