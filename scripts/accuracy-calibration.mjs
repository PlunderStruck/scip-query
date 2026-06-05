#!/usr/bin/env node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const cliPath = join(repoRoot, 'dist', 'cli.js');
const outDir = join(repoRoot, 'reports', 'accuracy');
const defaultRepos = [
  '/Users/aydansalois/Documents/GitHub/scip-query',
  '/Users/aydansalois/Documents/GitHub/SynthRunnerRust',
];
const repos = process.argv.slice(2).map((path) => resolve(path));
const targets = repos.length > 0 ? repos : defaultRepos;
const stamp = new Date().toISOString().slice(0, 10);
const outPath = join(outDir, `${stamp}-generated-real-repo-calibration.md`);

mkdirSync(outDir, { recursive: true });

const sections = [
  '# Accuracy Calibration',
  '',
  `Date: ${stamp}`,
  '',
  'This report records real-repository command outputs for manual precision checks.',
  'Treat every finding as untrusted until sampled against source evidence.',
  '',
];

for (const projectRoot of targets) {
  const cacheDir = mkdtempSync(join(tmpdir(), 'scip-query-calibrate-'));
  sections.push(`## ${basename(projectRoot)}`, '', `Path: \`${projectRoot}\``, '');
  try {
    const reindex = run(['reindex', '--force', '--indexer-concurrency', '1'], projectRoot, cacheDir, 90_000);
    sections.push('### reindex', fenced(reindex));

    if (reindex.status !== 0) {
      sections.push('Indexing failed; command accuracy was not measured for this repository.', '');
      continue;
    }

    for (const command of [
      ['health'],
      ['dead', '--min-loc', '5', '--skip-barrels'],
      ['stale-abstractions', '--min-loc', '3'],
      ['wrapper-candidates', '--max-loc', '15'],
      ['passthrough-candidates', '--max-loc', '15'],
      ['extract-candidates', '--min-loc', '15', '--min-callees', '5'],
      ['drift'],
      ['redundant-reexports'],
    ]) {
      const result = run(command, projectRoot, cacheDir, 60_000);
      sections.push(`### ${command.join(' ')}`, fenced(truncate(result, 12_000)));
    }
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

writeFileSync(outPath, sections.join('\n'));
console.log(outPath);

function run(args, projectRoot, cacheDir, timeout) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SCIP_QUERY_PROJECT_ROOT: projectRoot,
      SCIP_QUERY_CACHE_DIR: cacheDir,
    },
    encoding: 'utf8',
    timeout,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error?.message ?? '',
  };
}

function truncate(result, maxChars) {
  const output = `${result.stdout}${result.stderr ? `\nSTDERR:\n${result.stderr}` : ''}${result.error ? `\nERROR:\n${result.error}` : ''}`;
  if (output.length <= maxChars) return { ...result, stdout: output, stderr: '', error: '' };
  return {
    ...result,
    stdout: `${output.slice(0, maxChars)}\n\n[truncated ${output.length - maxChars} chars]`,
    stderr: '',
    error: '',
  };
}

function fenced(result) {
  const output = `${result.stdout}${result.stderr ? `\nSTDERR:\n${result.stderr}` : ''}${result.error ? `\nERROR:\n${result.error}` : ''}`.trimEnd();
  return [
    `status: ${result.status}`,
    '',
    '```text',
    output,
    '```',
    '',
  ].join('\n');
}
