import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const areas = ['indexing', 'graphs', 'pagination', 'scanner', 'cache', 'suppressions', 'boundaries', 'lifecycle'];
const { values } = parseArgs({
  options: {
    thorough: { type: 'boolean', default: false },
    area: { type: 'string', multiple: true },
    seed: { type: 'string' },
    path: { type: 'string' },
    test: { type: 'string' },
  },
});
const selected = [...new Set(values.area ?? areas)];
for (const area of selected) if (!areas.includes(area)) throw new Error(`Unknown property area: ${area}`);
if (values.path !== undefined && (selected.length !== 1 || !values.test || values.seed === undefined)) {
  throw new Error('Replay requires --area, --test, and --seed alongside --path.');
}
const directory = mkdtempSync(join(tmpdir(), 'scip-query-properties-'));
const receiptDirectory = join(directory, 'cases');
const args = ['run', ...selected.map((area) => `tests/properties/${area}.property.test.ts`), '--maxWorkers=2'];
if (values.test) args.push('--testNamePattern', values.test);
const env = {
  ...process.env,
  SCIP_PROPERTY_PROFILE: values.thorough ? 'thorough' : 'normal',
  SCIP_PROPERTY_RESULTS: receiptDirectory,
  ...(values.seed === undefined ? {} : { SCIP_PROPERTY_SEED: values.seed }),
  ...(values.path === undefined ? {} : { SCIP_PROPERTY_PATH: values.path }),
};
console.log(`Property receipts: ${directory}`);
const child = spawnSync(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), ...args], {
  env,
  stdio: 'inherit',
});
const receipts = existsSync(receiptDirectory) ? readdirSync(receiptDirectory) : [];
const runs = receipts.map((file) => JSON.parse(readFileSync(join(receiptDirectory, file), 'utf8')));
const summary = selected.map((area) => ({
  area,
  componentCases: runs
    .filter((run) => run.area === area && run.tier === 'component' && !run.failed && !run.interrupted)
    .reduce((n, run) => n + run.numRuns, 0),
  integrationCases: runs
    .filter((run) => run.area === area && run.tier === 'integration' && !run.failed && !run.interrupted)
    .reduce((n, run) => n + run.numRuns, 0),
  systemCases: runs
    .filter((run) => run.area === area && run.tier === 'system' && !run.failed && !run.interrupted)
    .reduce((n, run) => n + run.numRuns, 0),
  compilerCases: runs
    .filter((run) => run.area === area && run.tier === 'compiler' && !run.failed && !run.interrupted)
    .reduce((n, run) => n + run.numRuns, 0),
}));
const budget = values.thorough ? 200_000 : 200;
const incomplete = !values.test && summary.some((area) => area.componentCases < budget);
const failed =
  child.status !== 0 ||
  Boolean(child.error) ||
  runs.length === 0 ||
  runs.some((run) => run.failed || run.interrupted) ||
  incomplete;
writeFileSync(
  join(directory, 'summary.json'),
  JSON.stringify(
    { profile: env.SCIP_PROPERTY_PROFILE, selected, args, exitCode: child.status, failed, summary, runs },
    null,
    2,
  ) + '\n',
);
console.table(summary);
if (child.error) console.error(child.error);
if (incomplete) console.error('Requested generated-case budget was not completed.');
console.log(`Full results: ${join(directory, 'summary.json')}`);
process.exitCode = failed ? 1 : 0;
