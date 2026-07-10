import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { leafName } from '../../src/symbols/symbol-parser.js';

const cargo = findCargo();
const runIfCargo = cargo ? it : it.skip;

describe('native symbol leaf kernel', () => {
  const manifestPath = join(process.cwd(), 'crates/scip-query-kernels/Cargo.toml');

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

  runIfCargo('classifies consumer evidence batches', () => {
    const payload = {
      definitions: [
        {
          symbol_id: 7,
          leaf: 'target',
          consumer_files: [
            { file: 'src/real.ts', sources: ['indexed'] },
            { file: 'src/import-only.ts', sources: ['indexed', 'source-fallback'] },
            { file: 'src/barrel.ts', sources: ['indexed'] },
          ],
        },
      ],
      file_usages: {
        'src/real.ts': { imported_leaves: ['target'], used_leaves: ['target'] },
        'src/import-only.ts': { imported_leaves: ['target'], used_leaves: [] },
      },
      reexport_only_leaves: {
        'src/barrel.ts': ['target'],
      },
    };
    const output = execFileSync(
      cargo!,
      ['run', '--quiet', '--manifest-path', manifestPath, '--bin', 'scip-query-kernels', '--', 'consumer-classify'],
      {
        encoding: 'utf8',
        input: `${JSON.stringify(payload)}\n`,
      },
    );

    expect(JSON.parse(output)).toEqual({
      entries: [
        {
          symbol_id: 7,
          real_consumers: ['src/real.ts'],
          barrel_consumers: 1,
          import_only_consumers: 1,
          files: [
            { file: 'src/real.ts', sources: ['indexed'], classification: 'real' },
            {
              file: 'src/import-only.ts',
              sources: ['indexed', 'source-fallback'],
              classification: 'import-only',
            },
            { file: 'src/barrel.ts', sources: ['indexed'], classification: 'reexport-only' },
          ],
        },
      ],
    });
  });
});

function findCargo(): string | null {
  try {
    return execFileSync('sh', ['-lc', 'command -v cargo'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}
