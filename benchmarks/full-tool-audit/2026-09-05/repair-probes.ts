/** Fresh repair witnesses. Usage: vite-node repair-probes.ts INDEXED_FIXTURE OUTPUT_DIRECTORY */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fetchTlaToolsJar, runTlaTool } from '../../../src/tla/tool-runner.js';
import { exportSanyXml, parseSanyXmlFacts } from '../../../src/tla/sany-facts.js';

const root = resolve(process.argv[2]!);
const output = resolve(process.argv[3]!);
mkdirSync(output, { recursive: true });
const cli = resolve('dist/cli.js');
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SCIP_QUERY_'))),
  SCIP_QUERY_PROJECT_ROOT: root,
  SCIP_QUERY_CACHE_DIR: join(root, '.cache'),
};
const checks: Array<{ name: string; passed: boolean; error?: string }> = [];
async function check(name: string, test: () => unknown): Promise<void> {
  try {
    await test();
    checks.push({ name, passed: true });
  } catch (error) {
    checks.push({ name, passed: false, error: String(error) });
  }
}
function run(name: string, args: string[]) {
  const path = join(output, name + '.json');
  const result = spawnSync(process.execPath, [cli, ...args, '--json', '--json-output', path], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 45_000,
  });
  writeFileSync(join(output, name + '.log'), result.stdout + result.stderr);
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return { status: result.status, value: raw.result ?? raw };
}

await check('compiler-indexed call-free function has zero resolved callees', () => {
  const result = run('complexity-choose', ['complexity', 'choose']);
  assert.equal(result.status, 0);
  assert.equal(result.value.complexity.calleeCount, 0);
});
await check('compiler-indexed actual call retains its resolved callee', () => {
  assert.equal(run('complexity-run', ['complexity', 'run']).value.complexity.calleeCount, 1);
});
await check('an explicit missing file cannot return an unrelated symbol through the CLI', () => {
  const result = run('missing-file', ['code', './not-present/choose.ts']);
  assert.equal(result.value.missing, 1);
  assert.equal(result.value.matched, 0);
  assert.equal(result.value.entries[0].status, 'missing');
  assert.deepEqual(result.value.entries[0].results, []);
});
await check('declaration does not register a test callback', () => {
  const result = run('test-quality', ['test-quality']);
  assert.deepEqual(
    result.value.assertionFree.map((row: { startLine: number }) => row.startLine),
    [1],
  );
});

writeFileSync(join(root, 'Empty.tla'), '---- MODULE Empty ----\nInit == TRUE\nNext == TRUE\n====\n');
mkdirSync(join(root, 'unreadable-trace.json'), { recursive: true });
for (const [name, declared, explicit] of [
  ['mapping', ['missing-trace.json'], []],
  ['explicit', [], ['--trace', 'missing-trace.json']],
  ['duplicate', ['missing-trace.json'], ['--trace', './missing-trace.json']],
  ['malformed', ['bad-trace.json'], []],
  ['unreadable', ['unreadable-trace.json'], []],
] as const) {
  writeFileSync(join(root, 'bad-trace.json'), '{');
  writeFileSync(
    join(root, 'Empty.scip-tla.json'),
    JSON.stringify({ module: 'Empty.tla', variables: {}, actions: {}, traces: declared }),
  );
  await check(`${name} trace load failure survives verification`, () => {
    const result = run('trace-' + name, ['tla', 'verify', 'Empty.tla', '--checker', 'none', ...explicit]);
    assert.equal(result.status, 1);
    assert.equal(result.value.exitCode, 1);
    assert.ok(result.value.conformance.findings.some((finding: { severity: string }) => finding.severity === 'error'));
  });
}
await check('ordinary help exposes source maintenance and planning', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], { cwd: root, env, encoding: 'utf8' });
  writeFileSync(join(output, 'ordinary-help.txt'), result.stdout);
  for (const command of ['health', 'review', 'context']) assert.match(result.stdout, new RegExp(`^  ${command} `, 'm'));
});

const jar = join(root, '.cache', 'verified-tla2tools.jar');
await check('stable checker installs through the production checksum verifier', async () => {
  const downloaded = await fetchTlaToolsJar({ cachePath: jar });
  writeFileSync(join(output, 'checker-fetch.json'), JSON.stringify(downloaded, null, 2));
  assert.equal(downloaded.version, 'v1.7.4');
  assert.equal((await fetchTlaToolsJar({ cachePath: jar })).status, 'cached');
});
await check('altered checker bytes are rejected', async () => {
  await assert.rejects(
    fetchTlaToolsJar({
      cachePath: join(root, '.cache', 'corrupt.jar'),
      fetchImpl: async () => new Response('altered checker bytes'),
    }),
    /checksum|SHA-256|digest/i,
  );
});
const spec = join(root, 'Counter.tla');
writeFileSync(
  spec,
  "---- MODULE Counter ----\nEXTENDS Naturals\nVARIABLE x\nInit == x = 0\nNext == x' = 1 - x\nSafe == x \\in {0, 1}\nBad == x = 0\n====\n",
);
await check('real SANY parser exposes the intended variable and assignment', () => {
  const xml = exportSanyXml({ specPath: spec, jarPath: jar });
  assert.ok(xml);
  const facts = parseSanyXmlFacts(xml);
  writeFileSync(join(output, 'sany-facts.json'), JSON.stringify(facts, null, 2));
  assert.deepEqual(facts.variables, ['x']);
  assert.ok(facts.actions.some((action) => action.name === 'Next' && action.writes.includes('x')));
});
for (const [invariant, expected] of [
  ['Safe', 'passed'],
  ['Bad', 'failed'],
] as const) {
  await check(`real TLC ${expected} for ${invariant}`, () => {
    const config = join(root, 'Counter.cfg');
    writeFileSync(config, `INIT Init\nNEXT Next\nINVARIANT ${invariant}\n`);
    const result = runTlaTool({
      projectRoot: root,
      specPath: spec,
      configPath: config,
      checker: 'tlc',
      tlaToolsJar: jar,
      env,
      timeoutMs: 30_000,
    });
    writeFileSync(join(output, 'tlc-' + invariant + '.json'), JSON.stringify(result, null, 2));
    assert.equal(result.status, expected, result.stdout + result.stderr);
  });
}

writeFileSync(join(output, 'checks.json'), JSON.stringify(checks, null, 2) + '\n');
for (const result of checks)
  console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.name}${result.error ? ': ' + result.error : ''}`);
if (checks.some((result) => !result.passed)) process.exitCode = 1;
