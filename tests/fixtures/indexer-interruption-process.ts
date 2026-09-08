import fs from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

// This process exercises production source. Only the external filesystem and
// status boundaries are intercepted; no compiler/planner/publication is mocked.
const input = JSON.parse(fs.readFileSync(process.argv[2]!, 'utf8')) as {
  root: string;
  cache: string;
  point: string;
  action: 'pause' | 'fail' | 'cancel';
  started: string;
  checkpoint: string;
  release: string;
  forceFull?: boolean;
};
const originalRename = fs.renameSync;
const originalWrite = fs.writeFileSync;
const controller = new AbortController();
let hit = false;

function checkpoint(point: string): void {
  if (hit || point !== input.point) return;
  hit = true;
  originalWrite(input.checkpoint, JSON.stringify({ point, pid: process.pid }));
  if (input.action === 'fail') throw Object.assign(new Error(`Injected ENOSPC at ${point}`), { code: 'ENOSPC' });
  if (input.action === 'cancel') {
    controller.abort();
    return;
  }
  const timeout = performance.now() + 30_000;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(input.release)) {
    if (performance.now() >= timeout) throw new Error(`Unreleased test checkpoint: ${point}`);
    Atomics.wait(signal, 0, 0, 10);
  }
}

fs.renameSync = (source, target) => {
  const path = String(target);
  const pointer = path === join(input.cache, '.scipquery-generations', 'state.json');
  const database = path === join(input.cache, 'index.db');
  const metadata = path === join(input.cache, 'meta.json') && String(source).endsWith('.tmp-replace');
  if (pointer) checkpoint('before-pointer');
  if (database) checkpoint('before-database-mirror');
  originalRename(source, target);
  if (pointer) checkpoint('after-pointer');
  if (database) checkpoint('after-database-mirror');
  if (metadata) checkpoint('after-metadata-mirror');
};
syncBuiltinESMExports();

try {
  const { reindex } = await import('../../src/reindex/index.js');
  await reindex({
    projectRoot: input.root,
    outputDb: join(input.cache, 'index.db'),
    outputScip: join(input.cache, 'index.scip'),
    languages: ['typescript'],
    skipAutoInstall: true,
    signal: controller.signal,
    ...(input.forceFull ? { skipIfUnchanged: false } : {}),
    onStatus(message) {
      if (message.startsWith('Project fingerprint')) originalWrite(input.started, 'fingerprinted');
      if (message === 'Converting to SQLite...') checkpoint('before-conversion');
    },
  });
  if (!hit) throw new Error(`Test checkpoint was not reached: ${input.point}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
