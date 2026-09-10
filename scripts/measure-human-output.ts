/** Deterministic CLI output measurements; no coding-agent trials or model calls. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixtureDb, createFixtureProject } from '../tests/fixtures/command-accuracy-fixtures.js';

const commands = [
  ['code', 'src:watch:Watcher'],
  ['outline', 'src/watch.ts'],
  ['search', 'sharedOne'],
  [
    'evidence',
    '--at',
    'src/flow.ts:5',
    '--edge',
    'execution',
    '--direction',
    'outgoing',
    '--depth',
    '1',
    '--max-edges',
    '30',
  ],
  ['health'],
  ['system', '--source'],
  ['entrypoints'],
  ['--help'],
];
const output = resolve(process.argv[2] ?? '/tmp/scip-query-output-measurements');
const cli = resolve('dist/cli.js');
const root = mkdtempSync(join(tmpdir(), 'scip-query-output-measurement-'));
mkdirSync(output, { recursive: true });
try {
  createFixtureProject(root);
  createFixtureDb(join(root, 'index.db'));
  const measurements = commands.map((args, index) => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        SCIP_QUERY_PROJECT_ROOT: root,
        SCIP_QUERY_INDEX_DB: join(root, 'index.db'),
        SCIP_QUERY_SHARED_CACHE: '0',
        SCIP_QUERY_UPDATE_CHECK: '0',
        SCIP_QUERY_CACHE_DIR: join(root, '.cache'),
        XDG_CACHE_HOME: join(root, '.xdg'),
      },
    });
    if (result.error || result.status !== 0)
      throw new Error(`${args.join(' ')}: ${result.error?.message ?? result.stderr}`);
    const file = `${index}.txt`;
    writeFileSync(join(output, file), result.stdout);
    const saved = result.stdout.startsWith('Full result: ')
      ? result.stdout.split('\n')[0]!.slice('Full result: '.length)
      : undefined;
    if (saved) writeFileSync(join(output, `${index}.full.txt`), readFileSync(saved));
    return { args, file, bytes: Buffer.byteLength(result.stdout), saved: Boolean(saved) };
  });
  writeFileSync(join(output, 'manifest.json'), `${JSON.stringify({ schemaVersion: 1, measurements }, null, 2)}\n`);
  console.log(JSON.stringify(measurements));
} finally {
  rmSync(root, { recursive: true, force: true });
}
