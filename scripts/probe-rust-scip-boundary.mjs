import { spawnSync } from 'node:child_process';

const binary = process.env.RUST_ANALYZER ?? 'rust-analyzer';
const version = run(['--version']).trim();
const help = run(['scip', '--help']);
const section = help.match(/rust-analyzer scip[\s\S]*?(?=\nrust-analyzer |$)/)?.[0] ?? '';
const optionNames = [...section.matchAll(/^\s{4}(--[a-z][a-z-]*)/gm)].map((match) => match[1]);
const affectedOptions = optionNames.filter((option) => /file|document|affected|incremental/.test(option));

process.stdout.write(
  `${JSON.stringify(
    {
      binary,
      version,
      command: 'rust-analyzer scip <path> --output <path>',
      options: optionNames,
      affectedDocumentOptions: affectedOptions,
      stableAffectedDocumentBoundary: affectedOptions.length > 0,
      decision:
        affectedOptions.length > 0
          ? 'candidate-requires-output-parity-probe'
          : 'retain-whole-shard-fallback-upstream-boundary-unavailable',
    },
    null,
    2,
  )}\n`,
);

function run(args) {
  const result = spawnSync(binary, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${binary} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return `${result.stdout}${result.stderr}`;
}
