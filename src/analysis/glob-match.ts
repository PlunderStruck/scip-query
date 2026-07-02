import { readdirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

/**
 * Minimal glob matcher for project-relative paths.
 *
 * Deliberately narrow: only supports a literal path prefix followed by
 * exactly one trailing `*` (immediate children) or `**` (any depth,
 * including the prefix directory itself). That covers every config surface
 * that needs a glob today — coverage-contract `file-glob` sources
 * (`skills/*`) and `docs.snapshotPaths` (`docs/plans/**`) — without pulling
 * in a general-purpose glob dependency for patterns nothing uses.
 */
export function matchesGlob(pattern: string, relativePath: string): boolean {
  const normalizedPattern = normalize(pattern);
  const normalizedPath = normalize(relativePath);

  if (normalizedPattern.endsWith('/**')) {
    const prefix = normalizedPattern.slice(0, -3);
    return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
  }
  if (normalizedPattern.endsWith('/*')) {
    const prefix = normalizedPattern.slice(0, -2);
    if (!normalizedPath.startsWith(`${prefix}/`)) return false;
    const rest = normalizedPath.slice(prefix.length + 1);
    return rest.length > 0 && !rest.includes('/');
  }
  if (normalizedPattern === '**') return true;
  if (normalizedPattern === '*') return normalizedPath.length > 0 && !normalizedPath.includes('/');
  return normalizedPattern === normalizedPath;
}

/** The literal (non-glob) directory prefix — the safe root for an fs walk. */
export function globLiteralPrefix(pattern: string): string {
  return normalize(pattern).replace(/\/\*\*?$/, '');
}

/**
 * Every project-relative path under `projectRoot` that matches `pattern`.
 * Walks only from the pattern's literal prefix, so this stays cheap even on
 * large repos. Returns files and directories alike (callers pick).
 */
export function listGlobMatches(projectRoot: string, pattern: string): string[] {
  const normalizedPattern = normalize(pattern);
  const prefixRel = globLiteralPrefix(normalizedPattern);
  const recursive = normalizedPattern.endsWith('/**');
  const results: string[] = [];

  const walk = (absoluteDir: string, relativeDir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const rel = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (matchesGlob(normalizedPattern, rel)) results.push(rel);
      if (recursive && entry.isDirectory()) walk(join(absoluteDir, entry.name), rel);
    }
  };

  walk(join(projectRoot, prefixRel), prefixRel);
  return results.sort();
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}
