import { stronglyConnectedComponents } from '../../analysis/strongly-connected-components.js';
import type { ArchitectureConfig } from '../../domain/types.js';
import {
  analyzeSourceFunctions,
  FUNCTION_METRIC_RULES,
  type SourceFunction,
} from '../../source/ast/function-metrics.js';
import { maintenanceImports, type SourceImport } from '../../source/ast/maintenance-imports.js';
import { functionCoverage, type FunctionCoverage, type ReviewCoverage } from '../../source/maintenance-coverage.js';
import type { SourceSnapshot } from '../../source/maintenance-snapshot.js';
import { analyzeArchitectureGraph } from '../graph/architecture.js';

export interface FindingSite {
  file: string;
  line: number;
  name?: string;
}
export interface SourceFinding {
  id: string;
  rule: 'complexity' | 'duplication' | 'dependency-cycle' | 'architecture' | 'crap' | 'broken-dependency';
  evidence: 'derived' | 'candidate';
  summary: string;
  sites: FindingSite[];
  score: number;
  details: string[];
  status?: 'introduced' | 'worsened' | 'existing' | 'resolved' | 'uncomparable';
}

export interface MeasuredFunction extends SourceFunction {
  coverage: FunctionCoverage;
}
export interface SourceAnalysis {
  functions: MeasuredFunction[];
  findings: SourceFinding[];
  imports: SourceImport[];
  graph: Map<string, Set<string>>;
  problems: string[];
}

export const SOURCE_ANALYSIS_LIMITS = [
  `TS/JS implemented functions; metric rules ${FUNCTION_METRIC_RULES}. Cognitive counts structural nesting and logical sequences; recursion and interprocedural behavior are not measured.`,
  'Duplication compares whole function body tokens (at least 60 tokens), retaining literals and property names. Renamed local bindings are candidates; similarity does not prove interchangeable behavior or justify deletion.',
  'Dependencies cover static relative imports and re-exports, including type imports. Package aliases, CommonJS, dynamic imports, runtime handoffs, and other languages require indexed evidence or source inspection.',
  'Ownership and mixed responsibilities require evidence about callers, state and business rules; this scan does not infer a correct owner or an architectural grade.',
];

export function analyzeSourceSnapshot(
  snapshot: SourceSnapshot,
  coverage: ReviewCoverage = { files: {}, problem: 'No source-matched coverage supplied.' },
  architecture?: ArchitectureConfig,
): SourceAnalysis {
  const functions: MeasuredFunction[] = [];
  const imports: SourceImport[] = [];
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
    imports.push(...maintenanceImports(analysis.sourceFile, snapshot.files));
  }
  const graph = new Map([...snapshot.files.keys()].map((file) => [file, new Set<string>()]));
  for (const imported of imports) if (imported.target) graph.get(imported.file)!.add(imported.target);
  const findings = [
    ...complexityFindings(functions),
    ...duplicateFindings(functions),
    ...cycleFindings(graph, imports),
  ];
  const rules = analyzeArchitectureGraph(graph, [...snapshot.files.keys()], architecture);
  for (const edge of rules.forbiddenEdges) {
    // The architecture analyzer owns rule interpretation; use its complete edge evidence.
    findings.push({
      id: `architecture:${edge.from}:${edge.to}`,
      rule: 'architecture',
      evidence: 'derived',
      summary: `${edge.from} → ${edge.to}: ${edge.fileEdgeCount} file dependencies violate the declared rule.`,
      sites: edge.examples.map((example) => ({
        file: example.fromFile,
        line: imports.find((item) => item.file === example.fromFile && item.target === example.toFile)?.line ?? 1,
      })),
      score: edge.fileEdgeCount,
      details: edge.examples.map((example) => `${example.fromFile} → ${example.toFile}`),
    });
  }
  return { functions, findings: findings.sort(compareFindings), imports, graph, problems };
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

function cycleFindings(graph: Map<string, Set<string>>, imports: readonly SourceImport[]): SourceFinding[] {
  return stronglyConnectedComponents(graph)
    .components.filter((members) => members.length > 1 || graph.get(members[0]!)?.has(members[0]!))
    .map((members) => {
      const files = new Set(members);
      const edges = imports.filter((edge) => files.has(edge.file) && edge.target && files.has(edge.target));
      return {
        id: `dependency-cycle:${[...members].sort().join('|')}`,
        rule: 'dependency-cycle' as const,
        evidence: 'derived' as const,
        summary: `${members.length} file(s) form a circular static dependency component.`,
        score: members.length,
        sites: edges.map((edge) => ({ file: edge.file, line: edge.line })),
        details: edges.map((edge) => `${edge.file}:${edge.line} → ${edge.target} (${edge.kind} import)`),
      };
    });
}

export function compareFindings(a: SourceFinding, b: SourceFinding): number {
  const priority = { 'broken-dependency': 0, architecture: 1, 'dependency-cycle': 2, duplication: 3, crap: 4, complexity: 5 };
  return priority[a.rule] - priority[b.rule] || b.score - a.score || a.id.localeCompare(b.id);
}
