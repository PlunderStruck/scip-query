import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const out = resolve(process.argv[2] ?? '/tmp/scip-query-breadth-audit');
if (existsSync(join(out, 'baseline.json'))) throw new Error('Use a new output directory; baseline already exists');
mkdirSync(out, { recursive: true });
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : [];
  });
}
const paths = [
  ...files('src').filter((p) => /\.tsx?$/.test(p)),
  'tsup.config.ts',
  ...readdirSync('dist')
    .filter((p) => p.endsWith('.js'))
    .map((p) => join('dist', p)),
].sort();
const hashes = Object.fromEntries(
  paths.map((path) => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]),
);
const help = execFileSync(process.execPath, ['dist/cli.js', '--help-all'], { encoding: 'utf8' });
const commands = help.split('\n').flatMap((line) => {
  const match = /^  ([a-z_][a-z0-9_-]*)(?:\s+<[^>]+>|\s+\[[^\]]+\])*.*? {2,}\S/.exec(line);
  return match ? [match[1]] : [];
});
writeFileSync(
  join(out, 'baseline.json'),
  JSON.stringify({ commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), hashes }, null, 2) +
    '\n',
);
writeFileSync(join(out, 'help-all.txt'), help);
writeFileSync(join(out, 'command-names.json'), JSON.stringify([...new Set(commands)], null, 2) + '\n');
console.log(JSON.stringify({ out, hashedFiles: paths.length, commands: new Set(commands).size }));
