import type { ArchitectureConfig } from '../../domain/config-types.js';
import { matchesPathGlob } from '../../domain/path-glob.js';
import { stronglyConnectedComponents } from '../../analysis/strongly-connected-components.js';
import { classifyFile } from '../../source/primitives/file-kind.js';
import { sourceHash } from '../../source/ast/function-metrics.js';
import type { ImportResolution, SourceImport } from '../../source/ast/maintenance-imports.js';
import { analyzeArchitectureGraph, type ArchitectureReport } from '../graph/architecture.js';
import { architectureBoundaryForFile } from '../internal/architecture-policy.js';
import type { SourceFinding } from './source-finding-contract.js';

/** Keep the source report's policy context compact; full indexed graph evidence has its own command. */
export function sourceArchitectureContext(rules: ArchitectureReport) {
  return {
    configured: rules.configured,
    boundaries: rules.boundaries,
    coverage: rules.coverage,
    policyCoverage: rules.policyCoverage,
    dependencyRoles: rules.dependencyRoles,
    cycles: rules.cycles.map((cycle) => ({
      boundaries: cycle.boundaries,
      origin: cycle.origin,
      fileCycleMembers: cycle.fileCycleMembers,
      violatesPolicy: cycle.violatesPolicy,
    })),
  };
}

export function sourceTestFile(file: string, config?: ArchitectureConfig): boolean {
  return (
    classifyFile(file) === 'test' ||
    /(^|\/)(fixtures|benchmarks)(\/|$)/.test(file) ||
    (config?.testPaths ?? []).some((pattern) => matchesPathGlob(pattern, file))
  );
}

export function importGraph(files: readonly string[], imports: readonly SourceImport[]): Map<string, Set<string>> {
  const graph = new Map(files.map((file) => [file, new Set<string>()]));
  for (const edge of imports)
    if (edge.resolution === 'internal' && edge.target && graph.has(edge.target)) graph.get(edge.file)?.add(edge.target);
  return graph;
}

export function productionImports(imports: readonly SourceImport[], config?: ArchitectureConfig): SourceImport[] {
  return imports.filter(
    (edge) => !sourceTestFile(edge.file, config) && (!edge.target || !sourceTestFile(edge.target, config)),
  );
}

export function eagerValueImports(imports: readonly SourceImport[]): SourceImport[] {
  return imports.filter((edge) => edge.kind === 'value' && (edge.syntax === 'import' || edge.syntax === 'reexport'));
}

export function dependencyCoverage(imports: readonly SourceImport[]) {
  const resolutions: Record<ImportResolution, number> = {
    internal: 0,
    external: 0,
    builtin: 0,
    excluded: 0,
    missing: 0,
    ambiguous: 0,
    dynamic: 0,
  };
  for (const edge of imports) resolutions[edge.resolution]++;
  return {
    resolutions,
    typeOnly: imports.filter((edge) => edge.kind === 'type').length,
    test: imports.filter((edge) => edge.role === 'test').length,
    deferredOrCommonJs: imports.filter((edge) => edge.syntax === 'dynamic-import' || edge.syntax === 'require').length,
    unresolved: imports.filter(
      (edge) => edge.resolution === 'missing' || edge.resolution === 'ambiguous' || edge.resolution === 'dynamic',
    ),
    excluded: imports.filter((edge) => edge.resolution === 'excluded'),
  };
}

export function dependencyCycleFindings(files: readonly string[], imports: readonly SourceImport[]): SourceFinding[] {
  const edges = eagerValueImports(imports);
  const graph = importGraph(files, edges);
  return stronglyConnectedComponents(graph)
    .components.filter((members) => members.length > 1 || graph.get(members[0]!)?.has(members[0]!))
    .map((members) => {
      const contained = new Set(members);
      const references = edges.filter(
        (edge) =>
          edge.resolution === 'internal' && contained.has(edge.file) && edge.target && contained.has(edge.target),
      );
      return {
        id: `dependency-cycle:${sourceHash([...members].sort().join('\0'))}`,
        rule: 'dependency-cycle',
        evidence: 'derived',
        summary: `${members.length} production files form a circular component of static value imports.`,
        score: members.length,
        sites: references.map((edge) => ({ file: edge.file, line: edge.line })),
        details: references.map((edge) => `${edge.file}:${edge.line} → ${edge.target} (${edge.syntax}, ${edge.kind})`),
      };
    });
}

export function sourceArchitecture(
  files: readonly string[],
  imports: readonly SourceImport[],
  config?: ArchitectureConfig,
) {
  const production = productionImports(imports, config);
  const rules = analyzeArchitectureGraph(importGraph(files, production), files, config);
  const owners = new Map(files.map((file) => [file, architectureBoundaryForFile(config, file)]));
  const findings: SourceFinding[] = rules.forbiddenEdges.map((edge) => {
    const references = production.filter(
      (item) =>
        item.resolution === 'internal' &&
        item.target &&
        owners.get(item.file) === edge.from &&
        owners.get(item.target) === edge.to,
    );
    return {
      id: `architecture:${edge.from}:${edge.to}`,
      rule: 'architecture',
      evidence: 'derived',
      summary: `${edge.from} → ${edge.to}: ${edge.fileEdgeCount} production file dependencies violate the declared rule.`,
      sites: references.flatMap((item) => [
        { file: item.file, line: item.line },
        { file: item.target!, line: 1 },
      ]),
      score: edge.fileEdgeCount,
      details: references.map((item) => `${item.file}:${item.line} → ${item.target} (${item.kind}, ${item.syntax})`),
    };
  });
  for (const cycle of rules.cycles.filter((item) => item.violatesPolicy)) {
    const references = production.filter(
      (edge) =>
        edge.resolution === 'internal' &&
        edge.target &&
        cycle.boundaries.includes(owners.get(edge.file) ?? '') &&
        cycle.boundaries.includes(owners.get(edge.target) ?? ''),
    );
    findings.push({
      id: `architecture:group-cycle:${sourceHash(cycle.boundaries.join('\0'))}`,
      rule: 'architecture',
      evidence: 'derived',
      score: cycle.boundaries.length,
      summary: `${cycle.boundaries.length} declared groups violate requireAcyclic (${cycle.origin}); group identities are retained in architecture.cycles.`,
      sites: references.map((edge) => ({ file: edge.file, line: edge.line })),
      details: [
        rules.dependencyRoles!.cycleMeaning,
        ...references.map((edge) => `${edge.file}:${edge.line} → ${edge.target} (${edge.kind}, ${edge.syntax})`),
      ],
    });
  }
  for (const limit of rules.boundaryLimits)
    findings.push({
      id: `architecture:limit:${limit.boundary}:${limit.kind}`,
      rule: 'architecture',
      evidence: 'derived',
      score: limit.observed,
      summary: `${limit.boundary}: ${limit.observed} ${limit.kind} exceeds the declared limit ${limit.limit}.`,
      sites: files.filter((file) => owners.get(file) === limit.boundary).map((file) => ({ file, line: 1 })),
      details: ['A configured bound is a project rule, not proof that a group has multiple responsibilities.'],
    });
  if (rules.policyCoverage.requiresCompleteCoverage) {
    for (const file of rules.coverage.unmappedFiles)
      findings.push({
        id: `architecture:unmapped:${file}`,
        rule: 'architecture',
        evidence: 'derived',
        score: 1,
        summary: `${file} has no declared boundary and violates requireCompleteCoverage.`,
        sites: [{ file, line: 1 }],
        details: [],
      });
    for (const item of rules.coverage.ambiguousFiles)
      findings.push({
        id: `architecture:ambiguous:${item.file}`,
        rule: 'architecture',
        evidence: 'derived',
        score: item.boundaries.length,
        summary: `${item.file} matches multiple declared boundaries and violates requireCompleteCoverage.`,
        sites: [{ file: item.file, line: 1 }],
        details: item.boundaries,
      });
  }
  return { rules, findings };
}

export function unresolvedImportFindings(imports: readonly SourceImport[]): SourceFinding[] {
  return imports
    .filter((edge) => edge.resolution === 'missing' || edge.resolution === 'ambiguous')
    .map((edge) => ({
      id: `broken-dependency:${edge.file}:${edge.specifier}`,
      rule: 'broken-dependency',
      evidence: 'candidate',
      summary: `${JSON.stringify(edge.specifier)} ${edge.resolution === 'ambiguous' ? 'has conflicting project resolutions' : 'does not resolve in the captured internal source'}.`,
      sites: [{ file: edge.file, line: edge.line }],
      score: 1,
      details: [
        `Configuration: ${edge.configs.join(', ') || 'default compiler resolution'}.`,
        'Check the import, project configuration, generated files and custom loaders before treating this as a broken build.',
      ],
    }));
}

export function relationshipChanges(before: readonly SourceImport[], after: readonly SourceImport[]): string[] {
  const grouped = (imports: readonly SourceImport[]): Map<string, string> => {
    const result = new Map<string, string[]>();
    for (const edge of imports) {
      const facts = result.get(edge.file) ?? [];
      facts.push(
        JSON.stringify([
          edge.specifier,
          edge.target,
          edge.resolution,
          edge.kind,
          edge.role,
          edge.syntax,
          edge.alternatives,
        ]),
      );
      result.set(edge.file, facts);
    }
    return new Map([...result].map(([file, facts]) => [file, facts.sort().join('\n')]));
  };
  const old = grouped(before),
    next = grouped(after);
  return [...new Set([...old.keys(), ...next.keys()])].filter((file) => old.get(file) !== next.get(file)).sort();
}
