import type { WorkspacePackage } from '../../resolution/workspace-packages.js';

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
  const sourceRootRelative = `${pkg.relativeDir}/src`;
  return [
    `${sourceRootRelative}/index.ts`,
    `${sourceRootRelative}/index.tsx`,
    `${sourceRootRelative}/index.mts`,
    `${sourceRootRelative}/index.cts`,
  ];
}
