import type { ArchitectureConfig } from '../../domain/types.js';
import { loadReviewCoverage } from '../../source/maintenance-coverage.js';
import {
  assertSourceSnapshotCurrent,
  baseSourceSnapshot,
  currentSourceSnapshot,
  type SourceScanOptions,
} from '../../source/maintenance-snapshot.js';
import {
  analyzeSourceSnapshot,
  compareFindings,
  SOURCE_ANALYSIS_LIMITS,
  type MeasuredFunction,
  type SourceAnalysis,
  type SourceFinding,
} from './source-findings.js';

export interface SourceReviewOptions extends SourceScanOptions {
  base?: string;
  coverage?: string;
  scope?: string;
  architecture?: ArchitectureConfig;
}

export interface FunctionChange {
  status: 'added' | 'modified' | 'removed' | 'uncomparable';
  before?: MeasuredFunction;
  after?: MeasuredFunction;
  delta?: { cyclomatic: number; cognitive: number };
}

export interface SourceMaintenanceReport {
  mode: 'health' | 'review';
  base?: string;
  current: string;
  metricRules: string;
  changedFiles: string[];
  functions: FunctionChange[];
  findings: SourceFinding[];
  affectedFiles: string[];
  coverage: {
    status: 'accounted' | 'incomplete';
    analyzedFiles: number;
    eligibleFiles: number;
    excludedFiles: number;
    analyzedFunctions: number;
    unresolvedImports: number;
    problems: string[];
    limits: string[];
  };
}

export function sourceMaintenanceReport(projectRoot: string, opts: SourceReviewOptions = {}): SourceMaintenanceReport {
  const current = currentSourceSnapshot(projectRoot, opts);
  const analysis = analyzeSourceSnapshot(current, loadReviewCoverage(projectRoot, opts.coverage), opts.architecture);
  const base = opts.base === undefined ? undefined : baseSourceSnapshot(projectRoot, opts.base, opts);
  const before = base ? analyzeSourceSnapshot(base, undefined, opts.architecture) : undefined;
  const changedFiles = base
    ? [...new Set([...base.files.keys(), ...current.files.keys()])]
        .filter((file) => base.files.get(file) !== current.files.get(file))
        .sort()
    : [];
  const problems = [
    ...analysis.problems,
    ...(before?.problems.map((problem) => `base: ${problem}`) ?? []),
    ...assertSourceSnapshotCurrent(projectRoot, current, opts),
  ];
  const inScope = (file: string): boolean =>
    !opts.scope || file === opts.scope || file.startsWith(opts.scope.replace(/\/$/, '') + '/');
  const changed = new Set(changedFiles);
  const compared = before ? compareSourceFindings(before, analysis, changed, problems.length === 0) : analysis.findings;
  const functionChanges = before ? changedFunctions(before.functions, analysis.functions) : [];
  if (before) compared.push(...removedDependencyFindings(before, analysis, changed, problems.length === 0));
  return {
    mode: base ? 'review' : 'health',
    ...(base ? { base: base.revision } : {}),
    current: current.fingerprint,
    metricRules: 'typescript-function-local-v1',
    changedFiles: changedFiles.filter(inScope),
    functions: functionChanges.filter((change) => inScope((change.after ?? change.before)!.file)).map((change) =>
      problems.length ? { status: 'uncomparable', before: change.before, after: change.after } : change),
    findings: compared
      .filter((finding) => !opts.scope || finding.sites.some((site) => inScope(site.file)))
      .sort(compareFindings),
    affectedFiles: before ? [...new Set([
      ...affectedImporters(before.graph, new Set(changedFiles.filter(inScope))),
      ...affectedImporters(analysis.graph, new Set(changedFiles.filter(inScope))),
    ])].sort() : [],
    coverage: {
      status: problems.length ? 'incomplete' : 'accounted',
      analyzedFiles: current.files.size,
      eligibleFiles: current.eligibleFiles,
      excludedFiles: current.excludedFiles,
      analyzedFunctions: analysis.functions.length,
      unresolvedImports: analysis.imports.filter((edge) => !edge.target).length,
      problems,
      limits: [
        ...SOURCE_ANALYSIS_LIMITS,
        'Default exclusions: tests, fixtures, benchmarks, declarations, generated files and build output. Use --include-tests for tests and fixtures.',
        'Diff is the selected Git commit versus current files, including untracked files; staged-only review and inferred rename/split identity are not claimed.',
        'Coverage without matching source hashes is unavailable, never zero. Base CRAP is unavailable unless independently measured against that base.',
        'Affected files are transitive importers in the covered source graph. Use fresh diff-impact/evidence for symbol consumers and runtime effects.',
      ],
    },
  };
}

export function changedFunctions(
  before: readonly MeasuredFunction[],
  after: readonly MeasuredFunction[],
): FunctionChange[] {
  const key = (fn: MeasuredFunction): string => `${fn.file}:${fn.name}`;
  const grouped = (functions: readonly MeasuredFunction[]): Map<string, MeasuredFunction[]> => {
    const result = new Map<string, MeasuredFunction[]>();
    for (const fn of functions) result.set(key(fn), [...(result.get(key(fn)) ?? []), fn]);
    return result;
  };
  const old = grouped(before);
  const next = grouped(after);
  const changes: FunctionChange[] = [];
  for (const name of [...new Set([...old.keys(), ...next.keys()])].sort()) {
    const previous = old.get(name) ?? [];
    const current = next.get(name) ?? [];
    if (previous.length > 1 || current.length > 1) {
      if (previous.map((fn) => fn.sourceHash).join() !== current.map((fn) => fn.sourceHash).join()) {
        changes.push(
          ...previous.map((fn) => ({ status: 'uncomparable' as const, before: fn })),
          ...current.map((fn) => ({ status: 'uncomparable' as const, after: fn })),
        );
      }
    } else if (previous[0] && current[0]) {
      if (previous[0].sourceHash !== current[0].sourceHash)
        changes.push({
          status: 'modified',
          before: previous[0],
          after: current[0],
          delta: {
            cyclomatic: current[0].cyclomatic - previous[0].cyclomatic,
            cognitive: current[0].cognitive - previous[0].cognitive,
          },
        });
    } else if (current[0]) changes.push({ status: 'added', after: current[0] });
    else if (previous[0]) changes.push({ status: 'removed', before: previous[0] });
  }
  return changes;
}

function compareSourceFindings(
  before: SourceAnalysis,
  after: SourceAnalysis,
  changed: Set<string>,
  comparable: boolean,
): SourceFinding[] {
  const old = new Map(before.findings.map((finding) => [finding.id, finding]));
  const next = new Map(after.findings.map((finding) => [finding.id, finding]));
  const findings: SourceFinding[] = [];
  const ambiguous = ambiguousFunctionNames(before.functions, after.functions);
  for (const finding of after.findings) {
    if (finding.sites.length && !finding.sites.some((site) => changed.has(site.file))) continue;
    const previous = old.get(finding.id);
    const status =
        !comparable || finding.rule === 'crap' || finding.sites.some((site) => ambiguous.has(`${site.file}:${site.name}`))
        ? 'uncomparable'
        : !previous
          ? 'introduced'
          : finding.score > previous.score
            ? 'worsened'
            : 'existing';
    findings.push({ ...finding, status });
  }
  for (const finding of before.findings)
    if (!next.has(finding.id) && finding.sites.some((site) => changed.has(site.file))) {
      findings.push({ ...finding, status: comparable ? 'resolved' : 'uncomparable' });
    }
  return findings;
}

function ambiguousFunctionNames(before: readonly MeasuredFunction[], after: readonly MeasuredFunction[]): Set<string> {
  const count = (functions: readonly MeasuredFunction[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const fn of functions) { const key = `${fn.file}:${fn.name}`; counts.set(key, (counts.get(key) ?? 0) + 1); }
    return counts;
  };
  const old = count(before), next = count(after);
  return new Set([...old.keys(), ...next.keys()].filter((key) => (old.get(key) ?? 0) > 1 || (next.get(key) ?? 0) > 1));
}

function removedDependencyFindings(before: SourceAnalysis, after: SourceAnalysis, changed: Set<string>, comparable: boolean): SourceFinding[] {
  const previous = new Map(before.imports.map((edge) => [`${edge.file}:${edge.specifier}`, edge]));
  const findings: SourceFinding[] = [];
  for (const edge of after.imports) {
    if (edge.target) continue;
    const old = previous.get(`${edge.file}:${edge.specifier}`);
    if (!old?.target || !changed.has(old.target) || after.graph.has(old.target)) continue;
    findings.push({ id: `broken-dependency:${edge.file}:${edge.specifier}`, rule: 'broken-dependency', evidence: 'derived',
      status: comparable ? 'introduced' : 'uncomparable', summary: 'An unchanged import still refers to a removed source file.',
      sites: [{ file: edge.file, line: edge.line }, { file: old.target, line: 1 }], score: 1,
      details: [`${edge.specifier} resolved to ${old.target} at the base commit and no longer resolves in current source.`] });
  }
  return findings;
}

function affectedImporters(graph: ReadonlyMap<string, ReadonlySet<string>>, changed: Set<string>): string[] {
  const incoming = new Map<string, Set<string>>();
  for (const [file, targets] of graph)
    for (const target of targets) {
      const sources = incoming.get(target) ?? new Set<string>();
      sources.add(file);
      incoming.set(target, sources);
    }
  const seen = new Set(changed);
  const queue = [...changed];
  for (let cursor = 0; cursor < queue.length; cursor++)
    for (const file of incoming.get(queue[cursor]!) ?? []) {
      if (!seen.has(file)) {
        seen.add(file);
        queue.push(file);
      }
    }
  return [...seen].filter((file) => !changed.has(file)).sort();
}
