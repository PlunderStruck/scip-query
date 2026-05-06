import path from 'node:path';
import type { ScipDatabase } from '../db.js';
import { buildFileDepGraph } from '../reference-graph.js';
import { attributeIdentifierPermissive } from '../identifier-attribution.js';
import { classifyFile } from '../file-classifier.js';
import { getIdentifierLineMap } from '../identifier-index.js';
import { getRustAttrReferencedNames } from '../framework-patterns.js';
import { detectAstLanguage } from '../ast.js';
import { getSourceImports } from '../language-parsers/index.js';
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
    if (shouldSkipDriftFile(file)) continue;

    const referencedFiles = symbolRefs.get(file) ?? new Set<string>();

    for (const dep of deps) {
      if (shouldSkipDriftFile(dep)) continue;

      if (!referencedFiles.has(dep)) {
        // This file "depends on" dep but never references its symbols.
        // This can happen when the dep is imported for types only
        // (which don't appear in the mention graph). Skip type-heavy deps.
        if (isLikelyTypeOnlyDep(dep)) continue;
        // Side-effect-only imports (`import 'polyfill'`) intentionally
        // reference nothing — flagging them as "unused" would be wrong.
        if (isSideEffectImport(db, file, dep)) continue;

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
    if (shouldSkipDriftFile(file)) continue;

    const fileLayer = getArchitecturalLayer(file);
    for (const dep of deps) {
      if (shouldSkipDriftFile(dep)) continue;

      const depLayer = getArchitecturalLayer(dep);
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
    // Need a meaningful sample of siblings before "only one file does X" is
    // a signal — 3 siblings was too low (any small-fanout helper dir lit up).
    // Filter to "non-skipped siblings" so a 4-file dir with 3 tests doesn't
    // hit the threshold via the test counts.
    const realSiblings = files.filter((f) => !shouldSkipDriftFile(f));
    if (realSiblings.length < 5) continue;

    // Count dep frequency across siblings
    const depFreq = new Map<string, number>();
    for (const file of realSiblings) {
      for (const dep of depGraph.get(file) ?? []) {
        if (shouldSkipDriftFile(dep)) continue;
        depFreq.set(dep, (depFreq.get(dep) ?? 0) + 1);
      }
    }

    for (const file of realSiblings) {
      for (const dep of depGraph.get(file) ?? []) {
        if (shouldSkipDriftFile(dep)) continue;
        if ((depFreq.get(dep) ?? 0) !== 1) continue;
        // Skip same-directory deps (sibling imports are normal).
        if (path.dirname(dep) === dir) continue;
        // Skip deps that share the file's own *parent* directory — pulling
        // from a sibling subdir is the common Rust submodule pattern, not
        // drift.
        if (path.dirname(dep) === path.dirname(dir)) continue;
        results.push({
          file,
          kind: 'pattern-deviation',
          description: `Only file in ${dir}/ that depends on ${dep}`,
          dep,
        });
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
    JOIN (
      SELECT m2.symbol_id, c2.document_id
      FROM mentions m2
      JOIN chunks c2 ON m2.chunk_id = c2.id
      WHERE m2.role = 1
      GROUP BY m2.symbol_id
    ) sym_def ON sym_def.symbol_id = gs.id
    JOIN documents d2 ON sym_def.document_id = d2.id
    WHERE d1.id != d2.id
      AND m.role != 1
      ${db.pathExclusionsFor('d1', 'd2')}
      ${scopeFilter}`,
  );

  const graph = new Map<string, Set<string>>();
  for (const r of rows) {
    if (db.isIgnored(r.from_file) || db.isIgnored(r.to_file)) continue;
    if (!graph.has(r.from_file)) graph.set(r.from_file, new Set());
    graph.get(r.from_file)!.add(r.to_file);
  }

  // SCIP mentions miss many cross-file references (rust-analyzer skips a lot
  // of inherent-method calls; tsc-batch can drop method receivers). Without
  // augmentation, the drift "unused import" check fires whenever a real
  // dependency goes through one of those gaps. Walk every source file's
  // identifier list, attribute each to a SCIP symbol via the permissive
  // resolver, and credit the target's defining file as a referenced file.
  const docs = db.all<{ relative_path: string }>(
    `SELECT relative_path FROM documents
     WHERE 1 = 1 ${db.pathExclusionsFor('documents')}`,
  );
  for (const doc of docs) {
    if (db.isIgnored(doc.relative_path)) continue;
    if (!detectAstLanguage(doc.relative_path)) continue;
    const lineMap = getIdentifierLineMap(db, doc.relative_path);
    let bucket = graph.get(doc.relative_path);
    for (const name of lineMap.keys()) {
      const targets = attributeIdentifierPermissive(db, doc.relative_path, name);
      for (const t of targets) {
        if (t.relativePath === doc.relative_path) continue;
        if (db.isIgnored(t.relativePath)) continue;
        if (!bucket) { bucket = new Set(); graph.set(doc.relative_path, bucket); }
        bucket.add(t.relativePath);
      }
    }
    // Same string-attr augmentation we apply to the caller map: serde/
    // schemars/thiserror string args reference functions in OTHER files
    // (e.g. `#[serde(default = "crate::common::default_x")]`).
    if (detectAstLanguage(doc.relative_path) === 'rust') {
      const attrRefs = getRustAttrReferencedNames(db, doc.relative_path);
      for (const name of attrRefs) {
        const targets = attributeIdentifierPermissive(db, doc.relative_path, name);
        for (const t of targets) {
          if (t.relativePath === doc.relative_path) continue;
          if (db.isIgnored(t.relativePath)) continue;
          if (!bucket) { bucket = new Set(); graph.set(doc.relative_path, bucket); }
          bucket.add(t.relativePath);
        }
      }
    }
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
    if (shouldSkipDriftFile(file)) continue;

    const fromLayer = getArchitecturalLayer(file);
    layerSet.add(fromLayer);
    for (const dep of deps) {
      if (shouldSkipDriftFile(dep)) continue;

      const toLayer = getArchitecturalLayer(dep);
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

function getArchitecturalLayer(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);

  if (parts.length <= 1) {
    return '(root)';
  }

  if (parts.length >= 3 && ['src', 'lib', 'app', 'server', 'client'].includes(parts[0]!)) {
    return `${parts[0]!}/${parts[1]!}`;
  }

  return parts[0]!;
}

function isLikelyTypeOnlyDep(dep: string): boolean {
  return dep.includes('types') || dep.endsWith('.d.ts');
}

/**
 * True when `file` imports `dep` only via a side-effect import (`import 'x'`
 * with no bindings) or a `* as ns` namespace import where the namespace is
 * never accessed. Both legitimately reference no symbols from the dep, so
 * the "unused-import" heuristic shouldn't flag them.
 */
function isSideEffectImport(db: ScipDatabase, file: string, dep: string): boolean {
  const imports = getSourceImports(db, file).filter((entry) => entry.sourcePath === dep);
  if (imports.length === 0) return false;
  // If every import for this dep is a side-effect (no bindings), or an unused
  // namespace import, treat it as intentional.
  return imports.every((entry) =>
    entry.kind === 'side-effect'
    || (entry.kind === 'namespace' && entry.usedMembers.length === 0 && !entry.used),
  );
}

function shouldSkipDriftFile(filePath: string): boolean {
  // Defer to the shared file classifier — it knows about Rust `lib.rs` /
  // `mod.rs`, `*_tests.rs`, integration `tests/<name>.rs`, workers,
  // entry points, etc. Drift heuristics are noisy on those by nature
  // (entries / barrels / tests legitimately reach across the codebase),
  // so any of those classifications should suppress drift reports.
  const kind = classifyFile(filePath);
  if (kind === 'entry' || kind === 'barrel' || kind === 'test' || kind === 'worker') return true;
  // Health.ts is its own meta-roll-up of everything; drift on it is noise.
  if (isStructuralRole(path.basename(filePath))) return true;
  return false;
}

function isStructuralRole(basename: string): boolean {
  if (basename === 'index.ts' || basename === 'index.js') return true;
  if (basename === 'cli.ts' || basename === 'main.ts' || basename === 'main.rs') return true;
  if (basename.includes('worker.') || basename.includes('postinstall.')) return true;
  if (basename === 'health.ts' || basename === 'health.js') return true;
  return false;
}

function isTestLikePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const basename = path.basename(normalized);
  return normalized.includes('/__tests__/')
    || normalized.includes('/tests/')
    || normalized.includes('/test/')
    || /\.(test|spec)\.[A-Za-z0-9]+$/.test(basename)
    || /_(test|spec)\.[A-Za-z0-9]+$/.test(basename)
    || /^test[_-]/.test(basename)
    || /^test\./.test(basename);
}
