import type { SourceExportDeclaration } from '../../source/ast/function-metrics.js';
import type { SourceImport } from '../../source/ast/maintenance-imports.js';
import {
  assertSourceSnapshotCurrent,
  currentSourceSnapshot,
  type SourceScanOptions,
} from '../../source/maintenance-snapshot.js';
import { analyzeSourceSnapshot } from './source-findings.js';
import { sourceModuleInventory, type SourceModuleInventory } from './source-modules.js';
import { dependencyCoverage, productionImports, sourceArchitectureContext } from './source-dependencies.js';
import type { SourceFinding } from './source-finding-contract.js';

export interface SourceModuleEvidence extends SourceModuleInventory {
  exports: SourceExportDeclaration[];
  importIds: number[];
  incomingImportIds: number[];
}

export interface SourceModuleEdge {
  from: string;
  to: string;
  importIds: number[];
}

export interface SourceSystemReport {
  mode: 'source-system';
  current: string;
  selector?: string;
  totalModules: number;
  modules: SourceModuleEvidence[];
  /** Import IDs in groups/edges index this one report-local observation table. */
  imports: SourceImport[];
  edges: SourceModuleEdge[];
  findings: SourceFinding[];
  architecture: ReturnType<typeof sourceArchitectureContext>;
  coverage: {
    status: 'accounted' | 'incomplete';
    capturedFiles: number;
    eligibleFiles: number;
    excludedFiles: number;
    exclusions: Record<string, number>;
    dependencies: ReturnType<typeof dependencyCoverage>;
    problems: string[];
    limits: string[];
  };
}

/** One snapshot supplies the inventory, grammar-derived exports, imports, policy and review candidates. */
export function sourceSystemReport(
  projectRoot: string,
  selector?: string,
  opts: SourceScanOptions = {},
): SourceSystemReport {
  const snapshot = currentSourceSnapshot(projectRoot, opts);
  const analysis = analyzeSourceSnapshot(snapshot);
  const groups = sourceModuleInventory(
    [...snapshot.files.keys()],
    analysis.imports,
    analysis.findings,
    snapshot.project.architecture,
  );
  const selected = selectSourceModules(groups, selector);
  const files = new Set(selected.flatMap((group) => group.files));
  const dependencies = dependencyCoverage(analysis.imports);
  const problems = [
    ...analysis.problems,
    ...snapshot.project.problems,
    ...assertSourceSnapshotCurrent(projectRoot, snapshot, opts),
  ];
  if (selector && !selected.length)
    problems.push(
      `Selector ${JSON.stringify(selector)} matches no captured module; use system --source to inspect group IDs and exclusions.`,
    );
  if (dependencies.resolutions.missing || dependencies.resolutions.ambiguous)
    problems.push('Internal imports are missing or ambiguous; inspect coverage.dependencies.unresolved.');
  const exportsByFile = rowsByFile(analysis.exports);
  const imports = analysis.imports.filter((edge) => files.has(edge.file) || (edge.target && files.has(edge.target)));
  const importIds = new Map(imports.map((edge, id) => [edge, id]));
  const importsByFile = rowsByFile(imports);
  const incoming = incomingByFile(imports);
  return {
    mode: 'source-system',
    current: snapshot.fingerprint,
    selector,
    totalModules: groups.length,
    imports,
    modules: selected.map((group) => ({
      ...group,
      exports: group.files.flatMap((file) => exportsByFile.get(file) ?? []),
      importIds: group.files.flatMap((file) => importsByFile.get(file) ?? []).map((edge) => importIds.get(edge)!),
      incomingImportIds: group.files
        .flatMap((file) => incoming.get(file) ?? [])
        .filter((edge) => !group.files.includes(edge.file))
        .map((edge) => importIds.get(edge)!),
    })),
    edges: sourceModuleEdges(groups, productionImports(imports, snapshot.project.architecture), importIds).filter(
      (edge) => selected.some((group) => group.id === edge.from || group.id === edge.to),
    ),
    findings: analysis.findings.filter((finding) => finding.sites.some((site) => files.has(site.file))),
    architecture: sourceArchitectureContext(analysis.architecture),
    coverage: {
      status: problems.length ? 'incomplete' : 'accounted',
      capturedFiles: snapshot.files.size,
      eligibleFiles: snapshot.eligibleFiles,
      excludedFiles: snapshot.excludedFiles,
      exclusions: snapshot.exclusions,
      dependencies,
      problems,
      limits: [
        'Current TS/JS source and captured project configuration; no index or executed behavior is implied. Parse, resource and configuration failures are reported in problems.',
        'Import IDs index the imports table in this report; each observation is stored once. IDs are not portable between reports.',
        'Groups include files without findings. Unambiguous configured boundaries take precedence over provisional directories; membership does not establish business responsibility. A path selects whole groups containing matching files.',
        'Module edges and dependency/consumer summaries are observed internal production imports, including type, dynamic and CommonJS relationships; their syntax and roles remain explicit. They are not runtime execution paths. Only static value imports participate in production file-cycle findings.',
        'Export declarations are parsed source locations, not a complete resolved public API. Wildcard re-exports are not expanded; CommonJS exports, class member interfaces, external consumers, runtime registration and invocation coverage are not established. Use indexed surface/evidence and exact source when those facts matter.',
        'Nonliteral dynamic imports, custom loaders, runtime handoffs and shared external resources are not resolved. Coverage can be accounted for while these relationships remain unknown.',
        'Tests, generated/reference copies, declarations, unsupported languages and managed output are excluded by default; exclusion counts and opt-in source roles are reported. No architecture grade or module depth score is computed.',
      ],
    },
  };
}

function selectSourceModules(groups: SourceModuleInventory[], selector?: string): SourceModuleInventory[] {
  if (!selector || selector === '.') return groups;
  const exact = groups.find((group) => group.id === selector);
  if (exact) return [exact];
  const path = selector.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  return groups.filter((group) => group.files.some((file) => file === path || file.startsWith(path + '/')));
}

function rowsByFile<T extends { file: string }>(rows: readonly T[]): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const row of rows) {
    const group = result.get(row.file) ?? [];
    group.push(row);
    result.set(row.file, group);
  }
  return result;
}

function incomingByFile(imports: readonly SourceImport[]): Map<string, SourceImport[]> {
  const result = new Map<string, SourceImport[]>();
  for (const edge of imports) {
    if (edge.resolution !== 'internal' || !edge.target) continue;
    const group = result.get(edge.target) ?? [];
    group.push(edge);
    result.set(edge.target, group);
  }
  return result;
}

function sourceModuleEdges(
  groups: readonly SourceModuleInventory[],
  imports: readonly SourceImport[],
  importIds: ReadonlyMap<SourceImport, number>,
): SourceModuleEdge[] {
  const owners = new Map(groups.flatMap((group) => group.files.map((file) => [file, group.id] as const)));
  const edges = new Map<string, SourceModuleEdge>();
  for (const item of imports) {
    if (item.resolution !== 'internal' || !item.target) continue;
    const from = owners.get(item.file),
      to = owners.get(item.target);
    if (!from || !to || from === to) continue;
    const key = JSON.stringify([from, to]);
    const edge = edges.get(key) ?? { from, to, importIds: [] };
    edge.importIds.push(importIds.get(item)!);
    edges.set(key, edge);
  }
  return [...edges.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}
