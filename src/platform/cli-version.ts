import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileWithinLimit, SMALL_ARTIFACT_MAX_BYTES } from '../filesystem/bounded-file.js';

const require = createRequire(import.meta.url);

/** The installed scip-query package version that produced persistent artifacts. */
export const cliVersion = loadCliPackageInfo().version;

let buildIdentity: string | undefined;

/**
 * A digest of the running entry bundle. Two builds can share a version
 * string (a development install, a patched checkout), and artifacts keyed by
 * version alone would then serve one build's output for the other. The entry
 * bundle imports its chunks by content-hashed name, so its digest changes
 * whenever any bundled source changes. Source runs report `source`.
 */
export function cliBuildIdentity(): string {
  if (buildIdentity !== undefined) return buildIdentity;
  const entry = process.argv[1];
  try {
    buildIdentity = entry
      ? createHash('sha256')
          .update(readFileWithinLimit(entry, { maxBytes: SMALL_ARTIFACT_MAX_BYTES, inputKind: 'CLI entry bundle' }))
          .digest('hex')
          .slice(0, 16)
      : 'source';
  } catch {
    buildIdentity = 'source';
  }
  return buildIdentity;
}

function loadCliPackageInfo(): { version: string } {
  for (const path of ['../package.json', '../../package.json']) {
    try {
      return require(path) as { version: string };
    } catch {
      // Source runs from src/runtime; bundled entrypoints run from dist.
    }
  }
  return { version: '0.0.0' };
}
