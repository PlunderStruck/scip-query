import path from 'node:path';
import type { ScipDatabase } from '../db.js';
import { buildFileDepGraph } from '../query-support.js';
import type { DriftResult } from '../types.js';

/**
 * Detect pattern drift: files whose dependency profile deviates
 * significantly from their directory siblings.
 *
 * For each directory with >= 3 files, we compute the "median" dep set
 * (deps that appear in >50% of sibling files). Files that are missing
 * many expected deps or have many unexpected deps are flagged.
 */
export function drift(
  db: ScipDatabase,
  opts?: { scope?: string; minDeviation?: number },
): DriftResult[] {
  const { scope, minDeviation = 30 } = opts ?? {};

  // 1. Build the full file dependency graph
  const depGraph = buildFileDepGraph(db, scope);

  // 2. Group files by parent directory
  const dirToFiles = new Map<string, string[]>();
  for (const file of depGraph.keys()) {
    const dir = path.dirname(file);
    if (!dirToFiles.has(dir)) dirToFiles.set(dir, []);
    dirToFiles.get(dir)!.push(file);
  }

  const results: DriftResult[] = [];

  // 3. For each directory with >= 3 files, compute the median dep set
  for (const [dir, files] of dirToFiles) {
    if (files.length < 3) continue;

    // Count how many files in this dir depend on each target
    const depCounts = new Map<string, number>();
    for (const file of files) {
      const deps = depGraph.get(file) ?? new Set<string>();
      for (const dep of deps) {
        depCounts.set(dep, (depCounts.get(dep) ?? 0) + 1);
      }
    }

    // Median dep set: deps appearing in >50% of files in this dir
    const threshold = files.length / 2;
    const expectedDeps = new Set<string>();
    for (const [dep, count] of depCounts) {
      if (count > threshold) expectedDeps.add(dep);
    }

    // 4. For each file, compute deviation
    for (const file of files) {
      const actualDeps = depGraph.get(file) ?? new Set<string>();

      const missing = [...expectedDeps].filter((d) => !actualDeps.has(d));
      const unexpected = [...actualDeps].filter((d) => !expectedDeps.has(d));

      const totalUnion = expectedDeps.size + actualDeps.size;
      if (totalUnion === 0) continue;

      const deviation = ((missing.length + unexpected.length) / totalUnion) * 100;

      if (deviation >= minDeviation) {
        results.push({
          file,
          directory: dir,
          deviationPercent: Math.round(deviation * 100) / 100,
          missingExpectedDeps: missing,
          unexpectedDeps: unexpected,
        });
      }
    }
  }

  // Sort by deviation descending
  results.sort((a, b) => b.deviationPercent - a.deviationPercent);

  return results;
}
