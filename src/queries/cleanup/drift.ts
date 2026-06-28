import path from 'node:path';
import type { ScipDatabase } from '../../storage/db.js';
import { classifyFile } from '../../analysis/file-classifier.js';
import { getSourceImports } from '../../language-parsers/index.js';
import { ProjectIndex } from '../../core/project-index.js';
import { semanticImportUsage } from '../../semantic/shared-primitives.js';
import { indexedDocumentPaths } from '../../storage/scip-documents.js';
import { getArchitecturalLayer, isKnownProjectLayerDependency, layerPolicyForEdge } from './drift-policy.js';

export type DriftActionTier = 'direct' | 'signal';
export type DriftPolicyBasis = 'explicit' | 'inferred';

export interface DriftResult {
  file: string;
  kind: 'unused-import' | 'layer-violation' | 'pattern-deviation';
  description: string;
  /** The dependency involved */
  dep: string;
  /** For layer violations: the expected layer boundary */
  detail?: string;
  actionTier: DriftActionTier;
  /** For layer violations: whether the rule was explicit or inferred from rare edges. */
  policyBasis?: DriftPolicyBasis;
  evidenceReasons: string[];
  recommendation: string;
}

export interface DriftSummary {
  results: DriftResult[];
  unusedImports: number;
  layerViolations: number;
  patternDeviations: number;
}

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
// scip-query: ignore-extract — this is the user-facing drift report pipeline:
// file dependencies, symbol references, and the three drift families are
// intentionally assembled in one place.
export function drift(
  db: ScipDatabase,
  opts?: { scope?: string; minDeviation?: number; semantic?: boolean; includePatternDeviations?: boolean },
): DriftSummary {
  const { scope, minDeviation = 5 } = opts ?? {};
  const includeSemantic = opts?.semantic !== false;
  const includePatternDeviations = opts?.includePatternDeviations !== false;
  const index = new ProjectIndex(db);

  // Build file dep graph (which files depend on which)
  const depGraph = index.fileDependencyGraph(scope);

  return summarizeDrift([
    ...unusedImportDrift(db, depGraph, { scope, semantic: includeSemantic }),
    ...layerViolationDrift(depGraph),
    ...(includePatternDeviations ? patternDeviationDrift(depGraph, minDeviation) : []),
  ]);
}

// ── Helpers ────────────────────────────────────────────────

// scip-query: ignore-extract — this function is the conservative unused-import
// evidence gate; the ordered skips prevent false positives for semantic,
// type-only, side-effect, and Vue-template imports.
function unusedImportDrift(
  db: ScipDatabase,
  depGraph: Map<string, Set<string>>,
  opts: { scope?: string; semantic: boolean },
): DriftResult[] {
  const symbolRefs = buildScipSymbolRefGraph(db, opts.scope);
  const candidates: Array<{ file: string; dep: string }> = [];
  const candidateFiles = new Set<string>();

  for (const [file, deps] of depGraph) {
    if (shouldSkipDriftFile(file)) continue;

    const referencedFiles = symbolRefs.get(file) ?? new Set<string>();

    for (const dep of deps) {
      if (shouldSkipDriftFile(dep)) continue;
      if (referencedFiles.has(dep)) continue;
      if (hasConservativeImportUse(db, file, dep, opts)) continue;
      candidates.push({ file, dep });
      candidateFiles.add(file);
    }
  }

  if (candidateFiles.size > 0) {
    addSourceScannedSymbolRefEdges(db, symbolRefs, {
      paths: [...candidateFiles],
    });
  }

  const results: DriftResult[] = [];
  for (const { file, dep } of candidates) {
    const referencedFiles = symbolRefs.get(file) ?? new Set<string>();
    if (referencedFiles.has(dep)) continue;

    results.push({
      file,
      kind: 'unused-import',
      description: `Depends on ${dep} but references none of its symbols`,
      dep,
      actionTier: 'direct',
      evidenceReasons: [
        `dependency edge exists from ${file} to ${dep}`,
        'no semantic, source, type-only, side-effect, or Vue-template usage survived the conservative skip gates',
      ],
      recommendation: 'Remove the unused import or dependency edge after running the project checks.',
    });
  }
  return results;
}

function hasConservativeImportUse(db: ScipDatabase, file: string, dep: string, opts: { semantic: boolean }): boolean {
  // This file "depends on" dep but the SCIP graph does not show symbol
  // references. That can happen for type-only imports, side-effect imports,
  // Vue templates, or source/semantic reference gaps.
  if (hasUsedSourceImport(db, file, dep)) return true;
  if (isTypeOnlyImport(db, file, dep)) return true;
  if (isLikelyTypeOnlyDep(dep)) return true;
  if (isSideEffectImport(db, file, dep)) return true;
  if (isVueSingleFileComponent(dep)) return true;
  return opts.semantic && hasSemanticImportUse(db, file, dep);
}

function layerViolationDrift(depGraph: Map<string, Set<string>>): DriftResult[] {
  const results: DriftResult[] = [];
  const layerRules = inferLayerRules(depGraph);

  for (const [file, deps] of depGraph) {
    if (shouldSkipDriftFile(file)) continue;

    const fileLayer = getArchitecturalLayer(file);
    for (const dep of deps) {
      if (shouldSkipDriftFile(dep)) continue;

      const depLayer = getArchitecturalLayer(dep);
      if (fileLayer === depLayer) continue; // same layer, fine

      const explicitPolicy = layerPolicyForEdge(fileLayer, depLayer);
      const policyBasis: DriftPolicyBasis = explicitPolicy ? 'explicit' : 'inferred';
      const violation = explicitPolicy ?? layerRules.get(`${fileLayer}->${depLayer}`);
      if (violation === 'violation') {
        const actionTier: DriftActionTier = policyBasis === 'explicit' ? 'direct' : 'signal';
        results.push({
          file,
          kind: 'layer-violation',
          description: `Imports from ${depLayer}/ (${dep}) — may cross architectural boundary`,
          dep,
          detail: `${fileLayer}/ should not depend on ${depLayer}/`,
          actionTier,
          policyBasis,
          evidenceReasons: [
            `dependency edge exists from ${file} to ${dep}`,
            policyBasis === 'explicit'
              ? `explicit layer policy rejects ${fileLayer}/ -> ${depLayer}/`
              : `rare cross-layer edge ${fileLayer}/ -> ${depLayer}/ is inferred as a violation`,
          ],
          recommendation:
            policyBasis === 'explicit'
              ? 'Move the dependency behind an allowed layer boundary or document a policy change.'
              : 'Review whether this is a real boundary break or an intentional exception before moving code.',
        });
      }
    }
  }
  return results;
}

// scip-query: ignore-extract — this is the sibling-pattern scoring pass; the
// directory grouping, dependency frequency, and threshold are one decision.
function patternDeviationDrift(depGraph: Map<string, Set<string>>, minDeviation: number): DriftResult[] {
  const results: DriftResult[] = [];
  for (const [dir, files] of filesByDirectory(depGraph)) {
    // Need a meaningful sample of siblings before "only one file does X" is
    // a signal — 3 siblings was too low (any small-fanout helper dir lit up).
    // Filter to "non-skipped siblings" so a 4-file dir with 3 tests doesn't
    // hit the threshold via the test counts.
    const realSiblings = files.filter((f) => !shouldSkipDriftFile(f));
    if (realSiblings.length < minDeviation) continue;

    const depFreq = dependencyFrequency(depGraph, realSiblings);

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
        // For projects with an explicit layer policy, an allowed edge is not
        // drift just because only one sibling currently needs that adapter.
        if (isKnownProjectLayerDependency(file, dep)) continue;
        results.push({
          file,
          kind: 'pattern-deviation',
          description: `Only file in ${dir}/ that depends on ${dep}`,
          dep,
          actionTier: 'signal',
          evidenceReasons: [
            `${realSiblings.length} sibling file(s) in ${dir}/ were compared`,
            `${file} is the only non-skipped sibling depending on ${dep}`,
          ],
          recommendation:
            'Review sibling ownership before changing this import; unique dependency shape can be intentional specialization.',
        });
      }
    }
  }
  return results;
}

function summarizeDrift(results: DriftResult[]): DriftSummary {
  return {
    results,
    unusedImports: results.filter((r) => r.kind === 'unused-import').length,
    layerViolations: results.filter((r) => r.kind === 'layer-violation').length,
    patternDeviations: results.filter((r) => r.kind === 'pattern-deviation').length,
  };
}

function filesByDirectory(depGraph: Map<string, Set<string>>): Map<string, string[]> {
  const dirToFiles = new Map<string, string[]>();
  for (const file of depGraph.keys()) {
    const dir = path.dirname(file);
    let files = dirToFiles.get(dir);
    if (!files) {
      files = [];
      dirToFiles.set(dir, files);
    }
    files.push(file);
  }
  return dirToFiles;
}

function dependencyFrequency(depGraph: Map<string, Set<string>>, files: string[]): Map<string, number> {
  const depFreq = new Map<string, number>();
  for (const file of files) {
    for (const dep of depGraph.get(file) ?? []) {
      if (shouldSkipDriftFile(dep)) continue;
      depFreq.set(dep, (depFreq.get(dep) ?? 0) + 1);
    }
  }
  return depFreq;
}

/**
 * Build a map of file → set of files whose symbols it references.
 * This is more precise than the dep graph because it uses actual
 * symbol mentions, not just import statements.
 */
function buildScipSymbolRefGraph(db: ScipDatabase, scope?: string): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  addScipSymbolRefEdges(db, graph, scope);
  return graph;
}

function addScipSymbolRefEdges(db: ScipDatabase, graph: Map<string, Set<string>>, scope?: string): void {
  for (const edge of scipSymbolRefEdges(db, scope)) {
    addSymbolRefEdge(db, graph, edge.from_file, edge.to_file);
  }
}

function scipSymbolRefEdges(db: ScipDatabase, scope?: string): Array<{ from_file: string; to_file: string }> {
  const scopeFilter = scope ? `AND d1.relative_path LIKE '%${scope}%'` : '';
  return db.all<{ from_file: string; to_file: string }>(
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
}

// scip-query: ignore-extract — this adds source-scanned symbol edges; document
// loading, ignore filtering, source-reference scanning, and graph mutation are
// one fallback evidence source.
function addSourceScannedSymbolRefEdges(
  db: ScipDatabase,
  graph: Map<string, Set<string>>,
  opts: { paths?: readonly string[] } = {},
): void {
  const index = new ProjectIndex(db);
  // SCIP mentions miss many cross-file references (rust-analyzer skips a lot
  // of inherent-method calls; tsc-batch can drop method receivers). Without
  // augmentation, the drift "unused import" check fires whenever a real
  // dependency goes through one of those gaps.
  index.scanSourceReferences(
    {
      paths: opts.paths ?? indexedDocumentPaths(db, { includeIgnored: false }),
      includeRustAttributeNames: true,
      identifierResolution: 'permissive',
    },
    (hit) => {
      if (hit.target.relativePath === hit.sourceFile) return;
      if (db.isIgnored(hit.target.relativePath)) return;
      addSymbolRefEdge(db, graph, hit.sourceFile, hit.target.relativePath);
    },
  );
}

function addSymbolRefEdge(db: ScipDatabase, graph: Map<string, Set<string>>, fromFile: string, toFile: string): void {
  if (db.isIgnored(fromFile) || db.isIgnored(toFile)) return;
  let bucket = graph.get(fromFile);
  if (!bucket) {
    bucket = new Set();
    graph.set(fromFile, bucket);
  }
  bucket.add(toFile);
}

/**
 * Infer layer boundary rules from the dependency graph.
 * If directory A never depends on directory B across the entire codebase,
 * then a new A→B dependency is a violation.
 */
function inferLayerRules(depGraph: Map<string, Set<string>>): Map<string, 'ok' | 'violation'> {
  const layerEdges = new Map<string, number>();

  for (const [file, deps] of depGraph) {
    if (shouldSkipDriftFile(file)) continue;

    const fromLayer = getArchitecturalLayer(file);
    for (const dep of deps) {
      if (shouldSkipDriftFile(dep)) continue;

      const toLayer = getArchitecturalLayer(dep);
      if (fromLayer === toLayer) continue;
      if (layerPolicyForEdge(fromLayer, toLayer)) continue;
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

function isLikelyTypeOnlyDep(dep: string): boolean {
  return dep.includes('types') || dep.endsWith('.d.ts');
}

function hasSemanticImportUse(db: ScipDatabase, file: string, dep: string): boolean {
  const imports = semanticImportUsage(db, file).filter((entry) => entry.sourcePath === dep);
  return imports.length > 0 && imports.some((entry) => entry.isUsed);
}

function hasUsedSourceImport(db: ScipDatabase, file: string, dep: string): boolean {
  const imports = getSourceImports(db, file).filter((entry) => entry.sourcePath === dep);
  return imports.length > 0 && imports.some((entry) => entry.used);
}

function isTypeOnlyImport(db: ScipDatabase, file: string, dep: string): boolean {
  const imports = getSourceImports(db, file).filter((entry) => entry.sourcePath === dep);
  return imports.length > 0 && imports.every((entry) => entry.isTypeOnly === true);
}

function isVueSingleFileComponent(dep: string): boolean {
  return dep.endsWith('.vue');
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
  return imports.every(
    (entry) =>
      entry.kind === 'side-effect' || (entry.kind === 'namespace' && entry.usedMembers.length === 0 && !entry.used),
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
