import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TypeScriptDocumentRuntime } from '../../src/reindex/typescript-document-emitter.js';

export function cleanOracle(root: string, runtime: TypeScriptDocumentRuntime): Map<string, Buffer> {
  // A fresh standalone compiler process, independent of retained state and the
  // affected-set planner. Literal identity/binding expectations live in the
  // document-numbering tests; this oracle checks state-history equivalence.
  const mainPath = fileURLToPath(new URL('../../dist/typescript-indexer.js', import.meta.url));
  const outputPath = join(root, 'oracle.scip');
  execFileSync(process.execPath, [mainPath, 'index', '--cwd', root, '--output', outputPath, '--no-progress-bar', '.'], {
    cwd: root,
    stdio: 'pipe',
  });
  const index = runtime.Index.deserializeBinary(readFileSync(outputPath));
  return new Map(index.documents.map((document) => [document.relative_path, Buffer.from(document.serializeBinary())]));
}
