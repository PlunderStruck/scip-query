#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SCIP_REPOSITORY,
  DEFAULT_SCIP_TAG,
  PINNED_GO_VERSION,
  verifyWindowsSidecarProvenance,
} from './scip-windows-provenance.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sidecarDir = resolve(root, 'packages', 'scip-windows');

try {
  const manifest = verifyWindowsSidecarProvenance({
    sidecarDir,
    expectedSourceRepository: process.env.SCIP_REPO_URL ?? DEFAULT_SCIP_REPOSITORY,
    expectedSourceTag: process.env.SCIP_VERSION ?? DEFAULT_SCIP_TAG,
    expectedGoVersion: process.env.SCIP_GO_VERSION ?? PINNED_GO_VERSION,
  });
  console.log(
    `Verified ${manifest.package.name}@${manifest.package.version}: ${manifest.source.tag} (${manifest.source.commit.slice(0, 12)}), ${manifest.toolchain.goVersion}, ${manifest.binaries.length} PE binaries.`,
  );
} catch (error) {
  console.error(
    `Windows sidecar provenance check FAILED:\n  - ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
