import { matchesGlob } from '../../analysis/glob-match.js';
import type { ArchitectureConfig } from '../../domain/config-types.js';

export type ArchitectureDependencyStatus = 'allowed' | 'forbidden' | 'undeclared' | 'not-applicable';

/** Resolve a file to its single declared owner. Ambiguous and unmapped files remain unknown. */
export function architectureBoundaryForFile(config: ArchitectureConfig | undefined, file: string): string | null {
  const matches = (config?.boundaries ?? []).filter((boundary) =>
    boundary.paths.some((pattern) => matchesGlob(pattern, file)),
  );
  return matches.length === 1 ? matches[0]!.name : null;
}

/** Judge a proposed file dependency only when the repository has declared a closed policy row for it. */
export function architectureDependencyStatusForFiles(
  config: ArchitectureConfig | undefined,
  fromFile: string,
  toFile: string,
): ArchitectureDependencyStatus {
  const from = architectureBoundaryForFile(config, fromFile);
  const to = architectureBoundaryForFile(config, toFile);
  if (!from || !to || from === to) return 'not-applicable';
  if (!config?.allowedDependencies || !Object.hasOwn(config.allowedDependencies, from)) return 'undeclared';
  return config.allowedDependencies[from]!.includes(to) ? 'allowed' : 'forbidden';
}
