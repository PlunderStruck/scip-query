import type { ScipDatabase } from '../storage/db.js';
import { getDefinitionExclusions } from '../analysis/framework-patterns.js';
import { enclosingTypeNames } from '../symbols/definition-catalog.js';

/**
 * Build a per-file exclusion predicate: returns true when (file, startLine)
 * sits inside a framework-owned definition range (Tauri command handlers,
 * `#[cfg(test)] mod`, serde-derived fields, etc.) that the SCIP graph can't
 * see callers for. Range-based matching because SCIP fields' start_line
 * often points at the struct's opening line.
 */
export function buildFileExclusionPredicate(
  db: ScipDatabase,
): (relativePath: string, startLine: number, symbol: string, parentTypeName: string | null) => boolean {
  interface FileExclusions {
    ranges: Array<{ startLine: number; endLine: number }>;
    containers: Set<string>;
  }
  const exclusionsByFile = new Map<string, FileExclusions>();
  const ensure = (relativePath: string): FileExclusions => {
    let cached = exclusionsByFile.get(relativePath);
    if (cached) return cached;
    const entries = getDefinitionExclusions(db, relativePath);
    cached = {
      ranges: entries.map((e) => ({ startLine: e.startLine, endLine: e.endLine })),
      containers: new Set(entries.map((e) => e.containerName).filter((n): n is string => Boolean(n))),
    };
    exclusionsByFile.set(relativePath, cached);
    return cached;
  };
  return (relativePath, startLine, symbol, parentTypeName) => {
    const ex = ensure(relativePath);
    for (const r of ex.ranges) {
      if (startLine >= r.startLine && startLine <= r.endLine) return true;
    }
    if (parentTypeName && ex.containers.has(parentTypeName)) return true;
    // Walk the full enclosing-type chain: enum-variant fields' immediate
    // parent type is the variant, but we want the exclusion registered
    // against the enum to apply (thiserror error fields, sea-orm value
    // structs, anything where the framework-touched type is the outermost
    // wrapper rather than the closest parent).
    for (const name of enclosingTypeNames(symbol)) {
      if (ex.containers.has(name)) return true;
    }
    return false;
  };
}
