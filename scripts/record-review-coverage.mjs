#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Wrap an actual test run, proving its coverage was produced against unchanged source bytes. */
export function recordReviewCoverage({ root, input, output, command, args = [] }) {
  const inputPath = inside(root, input);
  const outputPath = inside(root, output);
  if (inputPath === outputPath) throw new Error('Coverage input and receipt output must be different files.');
  const before = runStableCoverageCommand(root, command, args, inputPath);
  const files = matchedCoverageFiles(root, inputPath, before);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(
    outputPath,
    JSON.stringify(
      { schemaVersion: 1, recordedAt: new Date().toISOString(), command: [command, ...args], files },
      null,
      2,
    ) + '\n',
  );
  return { output: outputPath, files: Object.keys(files).length };
}

function runStableCoverageCommand(root, command, args, inputPath) {
  const before = sourceHashes(root);
  const previous = existsSync(inputPath) ? statSync(inputPath, { bigint: true }) : null;
  const started = BigInt(Date.now()) * 1_000_000n;
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Test command did not succeed (${result.signal ?? result.status}). Coverage was not recorded.`);
  const current = statSync(inputPath, { bigint: true });
  if (current.mtimeNs < started || (previous && previous.mtimeNs === current.mtimeNs && previous.ino === current.ino)) {
    throw new Error('The test command did not produce a fresh coverage artifact.');
  }
  const after = sourceHashes(root);
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error('Source changed during the test run. Rerun against stable files.');
  return before;
}

function matchedCoverageFiles(root, inputPath, before) {
  const istanbul = JSON.parse(readFileSync(inputPath, 'utf8'));
  const files = {};
  for (const [key, coverage] of Object.entries(istanbul)) {
    const file = relative(root, resolve(root, coverage.path ?? key))
      .split(sep)
      .join('/');
    if (!before[file]) continue;
    if (!coverage.statementMap || !coverage.s) throw new Error(`Missing Istanbul statement coverage for ${file}.`);
    files[file] = { sourceHash: before[file], coverage };
  }
  if (Object.keys(files).length === 0) throw new Error('Coverage contains no source files matching this checkout.');
  return files;
}

function sourceHashes(root) {
  const paths = [
    ...new Set(
      execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      }).split('\0'),
    ),
  ].sort();
  const hashes = {};
  for (const file of paths) {
    if (!/\.[cm]?[jt]sx?$/.test(file) || /(^|\/)(node_modules|dist|build|coverage|\.scipquery)(\/|$)/.test(file))
      continue;
    const absolute = inside(root, file);
    if (existsSync(absolute)) hashes[file] = hash(readFileSync(absolute));
  }
  return hashes;
}

function inside(root, file) {
  const absolute = resolve(root, file);
  const rel = relative(root, existsSync(absolute) ? realpathSync(absolute) : absolute);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error(`Path escapes project: ${file}`);
  return absolute;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    const separator = argv.indexOf('--');
    if (separator < 0 || !argv[separator + 1])
      throw new Error(
        'Usage: node record-review-coverage.mjs [--input coverage/coverage-final.json] [--output .scipquery/coverage.json] -- <test-command> [args...]',
      );
    const flags = argv.slice(0, separator);
    let input = 'coverage/coverage-final.json';
    let output = '.scipquery/coverage.json';
    for (let i = 0; i < flags.length; i += 2) {
      if (!flags[i + 1]) throw new Error(`Missing value for ${flags[i]}`);
      if (flags[i] === '--input') input = flags[i + 1];
      else if (flags[i] === '--output') output = flags[i + 1];
      else throw new Error(`Unknown option: ${flags[i]}`);
    }
    const result = recordReviewCoverage({
      root: realpathSync(process.cwd()),
      input,
      output,
      command: argv[separator + 1],
      args: argv.slice(separator + 2),
    });
    process.stdout.write(`Recorded source-matched coverage for ${result.files} files: ${result.output}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
