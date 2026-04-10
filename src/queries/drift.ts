import path from 'node:path';
import type { ScipDatabase } from '../db.js';
import { buildFileDepGraph } from '../query-support.js';
import type { DriftResult, DriftSummary } from '../types.js';

/**
 * Detect structural drift using the reference graph, not just import patterns.
 *
 * Three types of drift, each detecting a real problem:
 *
 * 1. **Unused imports** — file depends on a module but never references
 *    any of its symbols. Dead dependency, safe to remove.
 *
 * 2. **Layer violations** — file imports from a directory it shouldn't
 *    based on the project's directory structure (e.g., a query importing
 *    from reindex, a helper importing from CLI). Architectural decay.
 *
 * 3. **Pattern deviations** — file imports something no sibling does,
 *    suggesting it's reaching outside its expected scope. Only flagged
 *    when the file is the ONLY one in its directory with that dep.
 */
export function drift(
  db: ScipDatabase,
  opts?: { scope?: string; minDeviation?: number },
): DriftSummary {
  const { scope } = opts ?? {};

  // Build file dep graph (which files depend on which)
  const depGraph = buildFileDepGraph(db, scope);

  // Build symbol-level reference graph: for each file, which other files'
  // symbols does it actually reference?
  const symbolRefs = buildSymbolRefGraph(db, scope);

  const results: DriftResult[] = [];

  // ── Angle 1: Unused imports ──────────────────────────────
  // File depends on module B (via dep graph) but never references
  // any symbol defined in B (via symbol ref graph).
  for (const [file, deps] of depGraph) {
    if (isStructuralRole(path.basename(file))) continue;

    const referencedFiles = symbolRefs.get(file) ?? new Set<string>();

    for (const dep of deps) {
      if (!referencedFiles.has(dep)) {
        // This file "depends on" dep but never references its symbols.
        // This can happen when the dep is imported for types only
        // (which don't appear in the mention graph). Skip type-heavy deps.
        if (isLikelyTypeOnlyDep(dep)) continue;

        results.push({
          file,
          kind: 'unused-import',
          description: `Depends on ${dep} but references none of its symbols`,
          dep,
        });
      }
    }
  }

  // ── Angle 2: Layer violations ────────────────────────────
  // Detect when a file imports from a directory that represents
  // a different architectural layer. We infer layers from the
  // directory structure: files in the same top-level dir are peers,
  // files in different top-level dirs crossing inward is a violation.
  const layerRules = inferLayerRules(depGraph);

  for (const [file, deps] of depGraph) {
    if (isStructuralRole(path.basename(file))) continue;

    const fileLayer = getTopDir(file);
    for (const dep of deps) {
      const depLayer = getTopDir(dep);
      if (fileLayer === depLayer) continue; // same layer, fine

      const violation = layerRules.get(`${fileLayer}->${depLayer}`);
      if (violation === 'violation') {
        results.push({
          file,
          kind: 'layer-violation',
          description: `Imports from ${depLayer}/ (${dep}) — may cross architectural boundary`,
          dep,
          detail: `${fileLayer}/ should not depend on ${depLayer}/`,
        });
      }
    }
  }

  // ── Angle 3: Unique deps (pattern deviation) ─────────────
  // If a file is the ONLY one in its directory that depends on a
  // particular module, that dependency is unusual and worth flagging.
  const dirToFiles = new Map<string, string[]>();
  for (const file of depGraph.keys()) {
    const dir = path.dirname(file);
    if (!dirToFiles.has(dir)) dirToFiles.set(dir, []);
    dirToFiles.get(dir)!.push(file);
  }

  for (const [dir, files] of dirToFiles) {
    if (files.length < 3) continue;

    // Count dep frequency across siblings
    const depFreq = new Map<string, number>();
    for (const file of files) {
      if (isStructuralRole(path.basename(file))) continue;
      for (const dep of depGraph.get(file) ?? []) {
        depFreq.set(dep, (depFreq.get(dep) ?? 0) + 1);
      }
    }

    for (const file of files) {
      if (isStructuralRole(path.basename(file))) continue;
      for (const dep of depGraph.get(file) ?? []) {
        if ((depFreq.get(dep) ?? 0) === 1) {
          // This file is the only one in its dir that depends on this module
          // Skip if dep is in the same directory (sibling imports are normal)
          if (path.dirname(dep) === dir) continue;

          results.push({
            file,
            kind: 'pattern-deviation',
            description: `Only file in ${dir}/ that depends on ${dep}`,
            dep,
          });
        }
      }
    }
  }

  return {
    results,
    unusedImports: results.filter((r) => r.kind === 'unused-import').length,
    layerViolations: results.filter((r) => r.kind === 'layer-violation').length,
    patternDeviations: results.filter((r) => r.kind === 'pattern-deviation').length,
  };
}

// ── Helpers ────────────────────────────────────────────────

/**
 * Build a map of file → set of files whose symbols it references.
 * This is more precise than the dep graph because it uses actual
 * symbol mentions, not just import statements.
 */
function buildSymbolRefGraph(
  db: ScipDatabase,
  scope?: string,
): Map<string, Set<string>> {
  const scopeFilter = scope ? `AND d1.relative_path LIKE '%${scope}%'` : '';

  const rows = db.all<{ from_file: string; to_file: string }>(
    `SELECT DISTINCT d1.relative_path AS from_file, d2.relative_path AS to_file
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN documents d1 ON c.document_id = d1.id
    JOIN global_symbols gs ON m.symbol_id = gs.id
    JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
    JOIN documents d2 ON der.document_id = d2.id
    WHERE d1.id != d2.id
      AND m.role = 0
      ${db.pathExclusionsFor('d1', 'd2')}
      ${scopeFilter}`,
  );

  const graph = new Map<string, Set<string>>();
  for (const r of rows) {
    if (db.isIgnored(r.from_file) || db.isIgnored(r.to_file)) continue;
    if (!graph.has(r.from_file)) graph.set(r.from_file, new Set());
    graph.get(r.from_file)!.add(r.to_file);
  }
  return graph;
}

/**
 * Infer layer boundary rules from the dependency graph.
 * If directory A never depends on directory B across the entire codebase,
 * then a new A→B dependency is a violation.
 */
function inferLayerRules(
  depGraph: Map<string, Set<string>>,
): Map<string, 'ok' | 'violation'> {
  const layerEdges = new Map<string, number>();
  const layerSet = new Set<string>();

  for (const [file, deps] of depGraph) {
    const fromLayer = getTopDir(file);
    layerSet.add(fromLayer);
    for (const dep of deps) {
      const toLayer = getTopDir(dep);
      if (fromLayer === toLayer) continue;
      layerSet.add(toLayer);
      const key = `${fromLayer}->${toLayer}`;
      layerEdges.set(key, (layerEdges.get(key) ?? 0) + 1);
    }
  }

  // An edge that appears only 1-2 times across the whole codebase
  // is likely a violation (anomalous cross-layer dep).
  // Edges that appear many times are established patterns.
  const rules = new Map<string, 'ok' | 'violation'>();
  for (const [edge, count] of layerEdges) {
    rules.set(edge, count <= 2 ? 'violation' : 'ok');
  }

  return rules;
}

function getTopDir(filePath: string): string {
  const parts = filePath.split('/');
  return parts[0] ?? filePath;
}

function isLikelyTypeOnlyDep(dep: string): boolean {
  return dep.includes('types') || dep.endsWith('.d.ts');
}

function isStructuralRole(basename: string): boolean {
  if (basename === 'index.ts' || basename === 'index.js') return true;
  if (basename === 'cli.ts' || basename === 'main.ts' || basename === 'main.rs') return true;
  if (basename.includes('worker.') || basename.includes('postinstall.')) return true;
  if (basename === 'health.ts' || basename === 'health.js') return true;
  return false;
}
