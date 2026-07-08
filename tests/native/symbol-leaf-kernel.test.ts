import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { leafName } from '../../src/symbols/symbol-parser.js';

const cargo = findCargo();
const runIfCargo = cargo ? it : it.skip;

describe('native symbol leaf kernel', () => {
  runIfCargo('matches the TypeScript leafName implementation on SCIP fixtures', () => {
    const symbols = [
      'scip-typescript npm @vega/api 0.1.3 src/modules/auth/`auth.service.ts`/AuthService#login().',
      'rust-analyzer cargo my-crate 0.1.0 src/`lib.rs`/MyStruct#new().',
      'scip-java maven com.example/mylib 1.0.0 com/example/MyClass#doStuff().',
      'scip-python pip my-package 1.0.0 my_module/`utils.py`/helper_function.',
      'scip-typescript npm pkg 1.0.0 `file.ts`/Generic#[T]',
      'scip-typescript npm pkg 1.0.0 `file.ts`/MyClass#method().(param)',
      'local 42',
    ];
    const manifestPath = join(process.cwd(), 'crates/scip-query-kernels/Cargo.toml');
    const output = execFileSync(
      cargo!,
      ['run', '--quiet', '--manifest-path', manifestPath, '--bin', 'scip-query-kernels', '--', 'leaf-name'],
      {
        encoding: 'utf8',
        input: `${symbols.join('\n')}\n`,
      },
    );

    expect(output.trimEnd().split('\n')).toEqual(symbols.map((symbol) => leafName(symbol)));
  });
});

function findCargo(): string | null {
  try {
    return execFileSync('sh', ['-lc', 'command -v cargo'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}
