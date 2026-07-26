import { createNpmReleaseRuntime, formatNpmReleaseError, runNpmRelease } from './npm-release.js';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--dry-run')) {
  console.error(`Usage: npm run release:npm [-- --dry-run]`);
  process.exitCode = 2;
} else {
  try {
    runNpmRelease(createNpmReleaseRuntime(), {
      mode: args.includes('--dry-run') ? 'dry-run' : 'publish',
    });
  } catch (error) {
    console.error(
      `npm release FAILED:\n  - ${formatNpmReleaseError(error).replaceAll('\n', '\n    ')}\n` +
        `  - Inspect .scipquery/releases/, then rerun npm run release:npm; ` +
        `the coordinator reconciles exact registry identities before continuing.`,
    );
    process.exitCode = 1;
  }
}
