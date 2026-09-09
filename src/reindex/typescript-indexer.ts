import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { loadTypeScriptDocumentRuntime } from './typescript-document-emitter.js';
import { typeScriptIndexVersion } from '../domain/typescript-index-identity.js';
import { installTypeScriptProjectEmission } from './typescript-project-emission.js';

// This process uses the upstream CLI and compiler with the same declaration
// identity adapter as the retained document emitter. No dependency files change.
const loaded = loadTypeScriptDocumentRuntime();
if (!loaded.available) throw new Error(loaded.reason);
const require = createRequire(import.meta.url);
const root = dirname(require.resolve('@sourcegraph/scip-typescript/package.json'));
const metadata = require(resolve(root, 'dist/package.json')) as { version: string };
metadata.version = typeScriptIndexVersion(loaded.runtime.packageVersion);
const { ProjectIndexer } = require(resolve(root, 'dist/src/ProjectIndexer.js')) as {
  ProjectIndexer: { prototype: Parameters<typeof installTypeScriptProjectEmission>[0] };
};
installTypeScriptProjectEmission(ProjectIndexer.prototype);
const { main } = require(resolve(root, 'dist/src/main.js')) as { main(): void };

// Upstream catches file visitor exceptions and can still write that file's
// partial document. Keep the first failure for this one synchronous CLI run
// and reject outside that catch so the runner cannot publish its output.
const prototype = loaded.runtime.FileIndexer.prototype;
const indexFile = prototype.index;
let fileFailure: Error | undefined;
prototype.index = function () {
  try {
    return indexFile.call(this);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const failure = new Error(`TypeScript indexing failed for ${this.sourceFile.fileName}: ${detail}`, { cause });
    fileFailure ??= failure;
    throw failure;
  }
};
main();
if (fileFailure) throw fileFailure;
