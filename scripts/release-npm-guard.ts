console.error(
  `Direct npm publish is disabled because it cannot own the complete two-package recovery protocol.\n` +
    `Run "npm run release:npm:dry-run" first, then "npm run release:npm".\n` +
    `The coordinator packs and tests both packages before publishing the Windows sidecar first and the main package last.`,
);
process.exitCode = 1;
