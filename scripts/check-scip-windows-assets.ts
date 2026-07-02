import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCIP_WINDOWS_ASSETS, type ScipWindowsArch } from '../src/runtime/scip-windows-assets.js';

const SHA256_RE = /^[0-9a-f]{64}$/;
const ARCHES: ScipWindowsArch[] = ['x64', 'arm64'];

function main(): void {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as { version: string };
  const problems: string[] = [];

  for (const archName of ARCHES) {
    const asset = SCIP_WINDOWS_ASSETS[archName];
    if (!asset) {
      problems.push(`missing SCIP_WINDOWS_ASSETS entry for win32-${archName}`);
      continue;
    }
    if (!asset.url.includes(`/v${pkg.version}/`)) {
      problems.push(
        `win32-${archName} asset url does not reference the current version (v${pkg.version}): ${asset.url}`,
      );
    }
    if (!SHA256_RE.test(asset.sha256)) {
      problems.push(
        `win32-${archName} sha256 is missing or a placeholder — pin it after uploading the v${pkg.version} release asset`,
      );
    }
  }

  if (problems.length > 0) {
    console.error('scip-query: Windows release asset check failed:');
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
      '\nBuild + upload with `npm run build:scip-windows`, then update src/runtime/scip-windows-assets.ts ' +
        '(url + sha256 for each arch) before publishing. See docs/plans/2026-07-02-release-readiness.md Phase 22.',
    );
    process.exit(1);
  }

  console.log(`scip-query: Windows release assets are pinned for v${pkg.version}.`);
}

main();
