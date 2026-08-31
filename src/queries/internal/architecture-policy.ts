import type { ArchitectureConfig } from '../../domain/config-types.js';
import { matchesPathGlob } from '../../domain/path-glob.js';

/** Resolve a file to its single declared owner. Ambiguous and unmapped files remain unknown. */
export function architectureBoundaryForFile(config: ArchitectureConfig | undefined, file: string): string | null {
  const matches = (config?.boundaries ?? []).filter((boundary) =>
    boundary.paths.some((pattern) => matchesPathGlob(pattern, file)),
  );
  return matches.length === 1 ? matches[0]!.name : null;
}
