import type { ScipDatabase } from '../../storage/db.js';
import {
  getDefinitionExclusions,
  type ExclusionDisposition,
  type ExclusionEntry,
} from '../../analysis/framework-patterns.js';
import { enclosingTypeNames } from '../../symbols/definition-catalog.js';

export interface FileExclusionClassification {
  disposition: ExclusionDisposition;
  reason: string;
}

/**
 * Build a per-file exclusion predicate: returns true when (file, startLine)
 * sits inside a hard exclusion range. Range-based matching because SCIP
 * fields' start_line often points at the struct's opening line.
 */
// scip-query: ignore-wrapper — public boolean view of the richer exclusion
// classifier, retained for query composition and framework-policy tests.
export function buildFileExclusionPredicate(
  db: ScipDatabase,
): (relativePath: string, startLine: number, symbol: string, parentTypeName: string | null) => boolean {
  const classify = buildFileExclusionClassifier(db);
  return (relativePath, startLine, symbol, parentTypeName) =>
    classify(relativePath, startLine, symbol, parentTypeName)?.disposition === 'exclude';
}

export function buildFileExclusionClassifier(
  db: ScipDatabase,
): (
  relativePath: string,
  startLine: number,
  symbol: string,
  parentTypeName: string | null,
) => FileExclusionClassification | null {
  interface FileExclusions {
    ranges: ExclusionEntry[];
    containers: Map<string, ExclusionEntry[]>;
  }
  const exclusionsByFile = new Map<string, FileExclusions>();
  const ensure = (relativePath: string): FileExclusions => {
    let cached = exclusionsByFile.get(relativePath);
    if (cached) return cached;
    const entries = getDefinitionExclusions(db, relativePath);
    const containers = new Map<string, ExclusionEntry[]>();
    for (const entry of entries) {
      if (!entry.containerName) continue;
      const bucket = containers.get(entry.containerName) ?? [];
      bucket.push(entry);
      containers.set(entry.containerName, bucket);
    }
    cached = {
      ranges: entries,
      containers,
    };
    exclusionsByFile.set(relativePath, cached);
    return cached;
  };
  return (relativePath, startLine, symbol, parentTypeName) => {
    const ex = ensure(relativePath);
    const matches: ExclusionEntry[] = [];
    for (const r of ex.ranges) {
      if (startLine >= r.startLine && startLine <= r.endLine) matches.push(r);
    }
    const names = new Set<string>();
    if (parentTypeName) names.add(parentTypeName);
    // Walk the full enclosing-type chain: enum-variant fields' immediate
    // parent type is the variant, but we want the exclusion registered
    // against the enum to apply (thiserror error fields, sea-orm value
    // structs, anything where the framework-touched type is the outermost
    // wrapper rather than the closest parent).
    for (const name of enclosingTypeNames(symbol)) {
      names.add(name);
    }
    for (const name of names) {
      const containerEntries = ex.containers.get(name);
      if (containerEntries) matches.push(...containerEntries);
    }
    return strongestMatch(matches);
  };
}

function strongestMatch(entries: readonly ExclusionEntry[]): FileExclusionClassification | null {
  if (entries.length === 0) return null;
  const hard = entries.find((entry) => entry.disposition === 'exclude');
  const entry = hard ?? entries[0]!;
  return {
    disposition: entry.disposition,
    reason: entry.reason,
  };
}
