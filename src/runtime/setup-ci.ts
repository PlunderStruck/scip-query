import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface SetupCiResult {
  path: string;
  written: boolean;
  skipped: boolean;
  content: string;
  reason?: string;
}

export function setupCiWorkflow(
  projectRoot: string,
  opts: { force?: boolean; dryRun?: boolean } = {},
): SetupCiResult {
  const path = join(projectRoot, '.github', 'workflows', 'scip-query.yml');
  const content = renderScipQueryWorkflow();
  if (existsSync(path) && !opts.force) {
    return {
      path,
      written: false,
      skipped: true,
      content,
      reason: 'Workflow already exists. Re-run with --force to overwrite.',
    };
  }
  if (!opts.dryRun) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return { path, written: !opts.dryRun, skipped: false, content };
}

function renderScipQueryWorkflow(): string {
  return `name: scip-query

on:
  pull_request:

jobs:
  diff-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npx scip-query reindex
      - run: npx scip-query diff-gate --base "origin/\${{ github.base_ref }}"
`;
}
