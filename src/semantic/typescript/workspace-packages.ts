import path from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

// scip-query: ignore-stale — exported semantic-provider record for a real
// workspace package root and its source root; structural inlining hides that domain.
export interface WorkspacePackage {
  name: string;
  rootRelative: string;
  sourceRootRelative: string;
}

export type PackageExportIndex = Map<string, Map<string, Set<number>>>;

export function discoverWorkspacePackages(projectRoot: string): WorkspacePackage[] {
  const packageJsonPath = path.join(projectRoot, 'package.json');
  if (!existsSync(packageJsonPath)) return [];

  let rootPackage: { workspaces?: string[] | { packages?: string[] } };
  try {
    rootPackage = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as typeof rootPackage;
  } catch {
    return [];
  }

  const patterns = Array.isArray(rootPackage.workspaces)
    ? rootPackage.workspaces
    : rootPackage.workspaces?.packages ?? [];

  return patterns
    .flatMap((pattern) => workspacePackageDirs(projectRoot, pattern))
    .flatMap((packageRoot) => workspacePackageFromDir(projectRoot, packageRoot));
}

function workspacePackageDirs(projectRoot: string, pattern: string): string[] {
  if (!pattern || pattern.startsWith('!') || pattern.includes('node_modules')) return [];
  if (!pattern.includes('*')) {
    const candidate = path.join(projectRoot, pattern);
    return existsSync(path.join(candidate, 'package.json')) ? [candidate] : [];
  }
  const star = pattern.indexOf('*');
  const prefix = pattern.slice(0, star).replace(/\/$/, '');
  const suffix = pattern.slice(star + 1).replace(/^\//, '');
  const base = path.join(projectRoot, prefix || '.');
  if (!existsSync(base)) return [];
  try {
    return readdirSync(base)
      .map((entry) => path.join(base, entry, suffix))
      .filter((candidate) => existsSync(path.join(candidate, 'package.json')));
  } catch {
    return [];
  }
}

function workspacePackageFromDir(projectRoot: string, packageRoot: string): WorkspacePackage[] {
  try {
    const packageJson = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as { name?: string };
    if (!packageJson.name) return [];
    const rootRelative = path.relative(projectRoot, packageRoot).replace(/\\/g, '/');
    return [{
      name: packageJson.name,
      rootRelative,
      sourceRootRelative: `${rootRelative}/src`,
    }];
  } catch {
    return [];
  }
}

export function workspacePackageNameForSpecifier(
  packages: ReadonlyArray<WorkspacePackage>,
  specifier: string,
): string | null {
  for (const pkg of packages) {
    if (specifier === pkg.name || specifier.startsWith(`${pkg.name}/`)) return pkg.name;
  }
  return null;
}

export function packageEntryCandidates(pkg: WorkspacePackage): string[] {
  return [
    `${pkg.sourceRootRelative}/index.ts`,
    `${pkg.sourceRootRelative}/index.tsx`,
    `${pkg.sourceRootRelative}/index.mts`,
    `${pkg.sourceRootRelative}/index.cts`,
  ];
}
