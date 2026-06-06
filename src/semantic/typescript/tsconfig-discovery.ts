import { existsSync } from 'node:fs';
import path from 'node:path';

const TSCONFIG_CANDIDATES = [
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.node.json',
  'tsconfig.base.json',
];

export function findNearestTsconfig(projectRoot: string, relativePath?: string): string | null {
  const startDir = relativePath
    ? path.dirname(path.join(projectRoot, relativePath))
    : projectRoot;
  let current = startDir;
  const root = path.resolve(projectRoot);

  while (current.startsWith(root)) {
    for (const name of TSCONFIG_CANDIDATES) {
      const candidate = path.join(current, name);
      if (existsSync(candidate)) return candidate;
    }
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }

  for (const name of TSCONFIG_CANDIDATES) {
    const candidate = path.join(projectRoot, name);
    if (existsSync(candidate)) return candidate;
  }

  return null;
}
