import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import {
  awaitVueReferenceWorkers,
  shouldUseVueWorkers,
  type VueWorkerRuntimePort,
} from '../../src/reindex/vue/augment-vue-workers.js';

const originalWorkerCount = process.env['SCIP_QUERY_AUGMENT_VUE_WORKERS'];
const resultDirectories = new Set<string>();

afterEach(() => {
  if (originalWorkerCount === undefined) {
    delete process.env['SCIP_QUERY_AUGMENT_VUE_WORKERS'];
  } else {
    process.env['SCIP_QUERY_AUGMENT_VUE_WORKERS'] = originalWorkerCount;
  }
  for (const directory of resultDirectories) rmSync(directory, { recursive: true, force: true });
  resultDirectories.clear();
});

describe('Vue reference worker policy', () => {
  it('uses the reliable single-context path by default', () => {
    delete process.env['SCIP_QUERY_AUGMENT_VUE_WORKERS'];

    expect(shouldUseVueWorkers(Array.from({ length: 500 }, (_, index) => `View${index}.vue`))).toBe(false);
  });

  it('keeps parallel workers available as an explicit opt-in', () => {
    process.env['SCIP_QUERY_AUGMENT_VUE_WORKERS'] = '2';

    expect(shouldUseVueWorkers(Array.from({ length: 8 }, (_, index) => `View${index}.vue`))).toBe(true);
  });
});

describe('Vue reference worker ownership', () => {
  it('merges successful results in stable worker order and authenticates task ownership', async () => {
    const runtime = fixtureRuntime(() => 'success');

    const result = await runWorkers(runtime);

    expect(result.occurrences.map((occurrence) => occurrence.sourceFile)).toEqual(['worker-0.vue', 'worker-1.vue']);
    expect(runtime.removedAfterTermination()).toBe(true);
    expect(runtime.handles.every((worker) => worker.threadId === -1)).toBe(true);
  });

  it('terminates a hanging worker before result-directory cleanup on timeout', async () => {
    const runtime = fixtureRuntime((workerId) => (workerId === 0 ? 'success' : 'hang'));

    await expect(runWorkers(runtime, { timeoutMs: 25 })).rejects.toThrow(/timed out/);

    expect(runtime.removedAfterTermination()).toBe(true);
    expect(runtime.handles.every((worker) => worker.threadId === -1)).toBe(true);
  });

  it('terminates unfinished peers when one worker emits an error', async () => {
    const runtime = fixtureRuntime((workerId) => (workerId === 0 ? 'error' : 'hang'));

    await expect(runWorkers(runtime)).rejects.toThrow(/worker 0 failed: fixture worker failure/);

    expect(runtime.removedAfterTermination()).toBe(true);
    expect(runtime.handles.every((worker) => worker.threadId === -1)).toBe(true);
  });

  it('prevents a late worker write from surviving into a subsequent run', async () => {
    const runtime = fixtureRuntime(() => 'late-write');

    await expect(runWorkers(runtime, { timeoutMs: 15 })).rejects.toThrow(/timed out/);
    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(runtime.resultDirectory()).not.toBeUndefined();
    expect(existsSync(runtime.resultDirectory()!)).toBe(false);
    expect(runtime.handles.every((worker) => worker.threadId === -1)).toBe(true);
  });

  it('rejects an oversized result before parsing it', async () => {
    const runtime = fixtureRuntime(() => 'oversized');

    await expect(runWorkers(runtime, { maxResultBytes: 128 })).rejects.toThrow(/result is 129 bytes; limit is 128/);

    expect(runtime.removedAfterTermination()).toBe(true);
  });

  it('rejects a result whose run identity does not match its assignment', async () => {
    const runtime = fixtureRuntime((workerId) => (workerId === 0 ? 'wrong-identity' : 'success'));

    await expect(runWorkers(runtime)).rejects.toThrow(/result identity does not match/);

    expect(runtime.removedAfterTermination()).toBe(true);
  });

  it('surfaces a worker-reported computation failure after all workers exit', async () => {
    const runtime = fixtureRuntime((workerId) => (workerId === 0 ? 'reported-failure' : 'success'));

    await expect(runWorkers(runtime)).rejects.toThrow(/worker 0 failed: fixture computation failure/);

    expect(runtime.removedAfterTermination()).toBe(true);
  });

  it('validates resource budgets before creating an owned result directory', async () => {
    const runtime = fixtureRuntime(() => 'success');

    await expect(runWorkers(runtime, { timeoutMs: 0 })).rejects.toThrow('timeoutMs must be a positive safe integer');

    expect(runtime.resultDirectory()).toBeUndefined();
    expect(runtime.handles).toHaveLength(0);
  });
});

type FixtureBehavior =
  | 'success'
  | 'hang'
  | 'error'
  | 'late-write'
  | 'oversized'
  | 'wrong-identity'
  | 'reported-failure';

interface FixtureRuntime extends VueWorkerRuntimePort {
  handles: Worker[];
  removedAfterTermination(): boolean;
  resultDirectory(): string | undefined;
}

function fixtureRuntime(behaviorForWorker: (workerId: number) => FixtureBehavior): FixtureRuntime {
  const handles: Worker[] = [];
  let resultDirectory: string | undefined;
  let safeRemoval = false;
  return {
    handles,
    createResultDirectory: () => {
      resultDirectory = mkdtempSync(join(tmpdir(), 'scip-query-vue-worker-test-'));
      resultDirectories.add(resultDirectory);
      return resultDirectory;
    },
    spawn: (_workerUrl, workerData) => {
      const handle = new Worker(FIXTURE_WORKER_SOURCE, {
        eval: true,
        workerData: { ...workerData, fixtureBehavior: behaviorForWorker(workerData.workerId) },
      });
      handles.push(handle);
      return handle;
    },
    resultSize: (path) => statSync(path).size,
    readResult: (path) => readFileSync(path, 'utf8'),
    removeResultDirectory: (path) => {
      safeRemoval = handles.every((handle) => handle.threadId === -1);
      rmSync(path, { recursive: true, force: true });
      resultDirectories.delete(path);
    },
    removedAfterTermination: () => safeRemoval,
    resultDirectory: () => resultDirectory,
  };
}

function runWorkers(runtime: VueWorkerRuntimePort, opts: { timeoutMs?: number; maxResultBytes?: number } = {}) {
  process.env['SCIP_QUERY_AUGMENT_VUE_WORKERS'] = '2';
  return awaitVueReferenceWorkers(
    {
      projectRoot: '/fixture',
      dbPath: '/fixture/index.db',
      tsconfig: 'tsconfig.json',
      vueFiles: ['/fixture/A.vue', '/fixture/B.vue'],
      ...opts,
    },
    runtime,
  );
}

const FIXTURE_WORKER_SOURCE = String.raw`
  const { workerData } = require('node:worker_threads');
  const { writeFileSync } = require('node:fs');
  const behavior = workerData.fixtureBehavior;
  const writeEnvelope = (override = {}) => {
    const result = {
      occurrences: [{
        sourceFile: 'worker-' + workerData.workerId + '.vue',
        sourceLine: 0,
        sourceStartChar: 0,
        sourceEndChar: 1,
        sourceToken: 'token',
        definitionFile: 'definition.ts',
        symbolId: workerData.workerId,
      }],
      skippedReferences: 0,
      skippedReferenceReasons: {
        'missing-source-file': 0,
        'missing-service-script': 0,
        'no-definition': 0,
        'same-file-definition': 0,
        'unindexed-definition': 0,
      },
      skippedReferenceSamples: [],
    };
    writeFileSync(workerData.resultPath, JSON.stringify({
      version: 1,
      runId: workerData.runId,
      workerId: workerData.workerId,
      taskIds: workerData.taskIds,
      ok: true,
      result,
      ...override,
    }));
  };
  if (behavior === 'hang') {
    setInterval(() => {}, 1000);
  } else if (behavior === 'error') {
    throw new Error('fixture worker failure');
  } else if (behavior === 'late-write') {
    setTimeout(() => writeEnvelope(), 60);
    setInterval(() => {}, 1000);
  } else if (behavior === 'oversized') {
    writeFileSync(workerData.resultPath, 'x'.repeat(129));
  } else if (behavior === 'wrong-identity') {
    writeEnvelope({ runId: 'wrong-run' });
  } else if (behavior === 'reported-failure') {
    writeFileSync(workerData.resultPath, JSON.stringify({
      version: 1,
      runId: workerData.runId,
      workerId: workerData.workerId,
      taskIds: workerData.taskIds,
      ok: false,
      error: 'fixture computation failure',
    }));
  } else {
    writeEnvelope();
  }
`;
