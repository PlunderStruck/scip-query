import { compareFindings, type MeasuredFunction, type SourceFinding } from './source-finding-contract.js';
export { compareFindings, type MeasuredFunction, type SourceFinding } from './source-finding-contract.js';
import { maintenanceBindings, type MaintenanceBindingFacts } from '../../source/ast/maintenance-bindings.js';
import { responsibilityFindings } from './source-modules.js';
import type { ArchitectureConfig } from '../../domain/types.js';
import { analyzeSourceFunctions, FUNCTION_METRIC_RULES } from '../../source/ast/function-metrics.js';
import { maintenanceImports, type SourceImport } from '../../source/ast/maintenance-imports.js';
import { functionCoverage, type ReviewCoverage } from '../../source/maintenance-coverage.js';
import type { SourceSnapshot } from '../../source/maintenance-snapshot.js';
import type { ArchitectureReport } from '../graph/architecture.js';
import {
  importGraph,
  productionImports,
  dependencyCycleFindings,
  sourceArchitecture,
  unresolvedImportFindings,
  sourceTestFile,
} from './source-dependencies.js';

export interface SourceAnalysis {
  functions: MeasuredFunction[];
  findings: SourceFinding[];
  imports: SourceImport[];
  graph: Map<string, Set<string>>;
  problems: string[];
  architecture: ArchitectureReport;
}

export const SOURCE_ANALYSIS_LIMITS = [
  `TS/JS implemented functions; metric rules ${FUNCTION_METRIC_RULES}. Cognitive counts structural nesting and logical sequences; recursion and interprocedural behavior are not measured.`,
  'Duplication compares whole function body tokens (at least 60 tokens), retaining literals and property names. Renamed local bindings are candidates; similarity does not prove interchangeable behavior or justify deletion.',
  'Dependencies use compiler resolution over captured source and project configuration, including aliases, repository package exports, literal dynamic imports and unshadowed CommonJS calls. External packages, excluded targets and unresolved imports are distinguished. Production file cycles use static value imports; type/test/deferred relationships remain separate. Runtime handoffs and custom loaders are not inferred.',
  'Ownership and mixed responsibilities require evidence about callers, state and business rules; this scan does not infer a correct owner or an architectural grade.',
];

export function analyzeSourceSnapshot(
  snapshot: SourceSnapshot,
  coverage: ReviewCoverage = { files: {}, problem: 'No source-matched coverage supplied.' },
  architecture?: ArchitectureConfig,
): SourceAnalysis {
  architecture ??= snapshot.project.architecture;
  const functions: MeasuredFunction[] = [];
  const imports: SourceImport[] = [];
  const bindingFacts: MaintenanceBindingFacts[] = [];
  const problems = [...snapshot.problems];
  for (const [file, source] of snapshot.files) {
    const analysis = analyzeSourceFunctions(file, source);
    problems.push(...analysis.errors);
    if (analysis.errors.length > 0) continue;
    functions.push(
      ...analysis.functions.map((fn) => ({
        ...fn,
        coverage: functionCoverage(fn, analysis.functions, source, coverage),
      })),
    );
    const fileImports = maintenanceImports(analysis.sourceFile, snapshot.files, snapshot.project, analysis.checker);
    for (const edge of fileImports) edge.role = sourceTestFile(file, architecture) ? 'test' : 'production';
    imports.push(...fileImports);
    if (!sourceTestFile(file, architecture)) bindingFacts.push(maintenanceBindings(analysis, fileImports));
  }
  const files = [...snapshot.files.keys()];
  const graph = importGraph(files, imports);
  const policy = sourceArchitecture(files, imports, architecture);
  const findings = [
    ...complexityFindings(functions),
    ...duplicateFindings(functions),
    ...dependencyCycleFindings(files, productionImports(imports, architecture)),
    ...policy.findings,
    ...unresolvedImportFindings(imports),
    ...responsibilityFindings(bindingFacts),
  ];
  return { functions, findings: findings.sort(compareFindings), imports, graph, problems, architecture: policy.rules };
}

function complexityFindings(functions: readonly MeasuredFunction[]): SourceFinding[] {
  const findings: SourceFinding[] = [];
  for (const fn of functions) {
    const site = { file: fn.file, line: fn.startLine, name: fn.name };
    if (fn.cyclomatic > 10 || fn.cognitive > 15)
      findings.push({
        id: `complexity:${fn.file}:${fn.name}`,
        rule: 'complexity',
        evidence: 'derived',
        summary: `${fn.name}: cyclomatic ${fn.cyclomatic}, cognitive ${fn.cognitive}.`,
        sites: [site],
        score: Math.max(fn.cyclomatic / 10, fn.cognitive / 15),
        details: [
          'Review branching and nesting while preserving decisions, effects, and error handling.',
          ...fn.contributions
            .filter((part) => part.cognitive > 1)
            .map((part) => `${fn.file}:${part.line}:${part.column} ${part.kind}: +${part.cognitive} cognitive`),
        ],
      });
    if (fn.coverage.status === 'available' && fn.coverage.crap! >= 30)
      findings.push({
        id: `crap:${fn.file}:${fn.name}`,
        rule: 'crap',
        evidence: 'derived',
        score: fn.coverage.crap!,
        sites: [site],
        summary: `${fn.name}: CRAP ${fn.coverage.crap}, measured line coverage ${Math.round(fn.coverage.fraction! * 100)}%.`,
        details: [
          'CRAP = cyclomatic² × (1 − measured coverage)³ + cyclomatic. Improve tests and simplify behavior where justified.',
        ],
      });
  }
  return findings;
}

function duplicateFindings(functions: readonly MeasuredFunction[]): SourceFinding[] {
  const groups = new Map<string, MeasuredFunction[]>();
  for (const fn of functions) {
    if (fn.tokenCount < 60) continue;
    const key = fn.renamedBodyHash;
    const group = groups.get(key) ?? [];
    group.push(fn);
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => {
      const exact = new Set(group.map((fn) => fn.bodyHash)).size === 1;
      const sites = group.map((fn) => ({ file: fn.file, line: fn.startLine, name: fn.name }));
      return {
        id: `duplication:${group[0]!.renamedBodyHash}`,
        rule: 'duplication' as const,
        evidence: 'candidate' as const,
        summary: `${group.length} functions share ${exact ? 'identical body tokens' : 'body tokens after local binding renaming'}.`,
        sites,
        score: group.length,
        details: [
          `${group[0]!.tokenCount} tokens per body; comments and whitespace excluded; literals retained.`,
          'Read both contracts and callers. If these implementations own the same rule, reuse one owner; otherwise retain the separate responsibilities.',
        ],
      };
    });
}
