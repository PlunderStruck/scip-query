import { writeFileSync } from 'node:fs';
import { workerData } from 'node:worker_threads';
import { computeVueResolvedReferencesForWorker } from './augment-vue.js';

const data = workerData as Parameters<typeof computeVueResolvedReferencesForWorker>[0] & {
  resultPath: string;
  sharedBuffer: SharedArrayBuffer;
};

try {
  const result = computeVueResolvedReferencesForWorker({
    projectRoot: data.projectRoot,
    dbPath: data.dbPath,
    tsconfig: data.tsconfig,
    vueFiles: data.vueFiles,
    tasks: data.tasks,
  });
  writeFileSync(data.resultPath, JSON.stringify({ ok: true, result }));
} catch (error) {
  writeFileSync(data.resultPath, JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));
} finally {
  const signal = new Int32Array(data.sharedBuffer);
  Atomics.add(signal, 0, 1);
  Atomics.notify(signal, 0);
}
