import { writeFileSync } from 'node:fs';
import { workerData } from 'node:worker_threads';
import { computeVueResolvedReferencesForWorker } from './augment-vue.js';

const data = workerData as Parameters<typeof computeVueResolvedReferencesForWorker>[0] & {
  runId: string;
  workerId: number;
  taskIds: string[];
  resultPath: string;
};

try {
  const result = computeVueResolvedReferencesForWorker({
    projectRoot: data.projectRoot,
    dbPath: data.dbPath,
    tsconfig: data.tsconfig,
    vueFiles: data.vueFiles,
    tasks: data.tasks,
  });
  writeFileSync(
    data.resultPath,
    JSON.stringify({
      version: 1,
      runId: data.runId,
      workerId: data.workerId,
      taskIds: data.taskIds,
      ok: true,
      result,
    }),
  );
} catch (error) {
  writeFileSync(
    data.resultPath,
    JSON.stringify({
      version: 1,
      runId: data.runId,
      workerId: data.workerId,
      taskIds: data.taskIds,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}
