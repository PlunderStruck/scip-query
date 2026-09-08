import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import type { TypeScriptDocumentRuntime } from '../../src/reindex/typescript-document-emitter.js';
const require = createRequire(import.meta.url);

export function cleanOracle(root: string, runtime: TypeScriptDocumentRuntime): Map<string, Buffer> {
  const packagePath = require.resolve('@sourcegraph/scip-typescript/package.json');
  const mainPath = join(dirname(packagePath), 'dist/src/main.js');
  const outputPath = join(root, 'oracle.scip');
  execFileSync(process.execPath, [mainPath, 'index', '--cwd', root, '--output', outputPath, '--no-progress-bar', '.'], {
    cwd: root,
    stdio: 'pipe',
  });
  const index = runtime.Index.deserializeBinary(readFileSync(outputPath));
  return new Map(index.documents.map((document) => [document.relative_path, Buffer.from(document.serializeBinary())]));
}
