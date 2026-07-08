#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const root = process.cwd();
const distIndex = join(root, 'dist/index.js');
const manifestPath = join(root, 'crates/scip-query-kernels/Cargo.toml');
const binaryName = process.platform === 'win32' ? 'scip-query-kernels.exe' : 'scip-query-kernels';
const binaryPath = join(root, 'target/release', binaryName);
const count = Number.parseInt(process.env.SCIP_NATIVE_BENCH_SYMBOLS ?? '100000', 10);

if (!existsSync(distIndex)) {
  console.error('dist/index.js is missing; run npm run build before this benchmark.');
  process.exit(1);
}

const { leafName } = await import(`file://${distIndex}`);

const fixtures = [
  'scip-typescript npm @vega/api 0.1.3 src/modules/auth/`auth.service.ts`/AuthService#login().',
  'rust-analyzer cargo my-crate 0.1.0 src/`lib.rs`/MyStruct#new().',
  'scip-java maven com.example/mylib 1.0.0 com/example/MyClass#doStuff().',
  'scip-python pip my-package 1.0.0 my_module/`utils.py`/helper_function.',
  'scip-typescript npm pkg 1.0.0 `file.ts`/Generic#[T]',
  'scip-typescript npm pkg 1.0.0 `file.ts`/MyClass#method().(param)',
  'local 42',
];

const symbols = Array.from({ length: count }, (_, index) => fixtures[index % fixtures.length]);
const input = `${symbols.join('\n')}\n`;

const build = spawnSync('cargo', ['build', '--quiet', '--release', '--manifest-path', manifestPath], {
  encoding: 'utf8',
});
if (build.status !== 0) {
  console.error(build.stderr || build.stdout || 'cargo build failed');
  process.exit(build.status ?? 1);
}

const jsStart = performance.now();
const jsLeaves = symbols.map((symbol) => leafName(symbol));
const jsMs = performance.now() - jsStart;

const nativeStart = performance.now();
const nativeOutput = execFileSync(binaryPath, ['leaf-name'], {
  encoding: 'utf8',
  input,
  maxBuffer: Math.max(1024 * 1024, input.length),
});
const nativeHelperMs = performance.now() - nativeStart;
const nativeLeaves = nativeOutput.trimEnd().split('\n');

const equivalent =
  nativeLeaves.length === jsLeaves.length && nativeLeaves.every((leaf, index) => leaf === jsLeaves[index]);

console.log(
  JSON.stringify(
    {
      kernel: 'symbol.leafName',
      count,
      equivalent,
      jsMs: Math.round(jsMs),
      nativeHelperMs: Math.round(nativeHelperMs),
      note: 'nativeHelperMs includes helper process startup and stdin/stdout transfer; production native embedding would need a separate benchmark.',
    },
    null,
    2,
  ),
);

if (!equivalent) process.exit(1);
