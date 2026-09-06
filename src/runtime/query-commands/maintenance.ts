import { sourceMaintenanceReport, type SourceMaintenanceReport } from '../../queries/index.js';
import { resolveCliProjectContext } from '../cli-context.js';
import {
  booleanOptionValue,
  commandOptions,
  numberOptionValue,
  printJsonEnvelope,
  stringOptionValue,
} from '../command-kit/command-execution.js';

export function handleSourceHealth(rawOpts: unknown): void {
  runSourceMaintenance(rawOpts, 'health');
}
export function handleSourceReview(rawOpts: unknown): void {
  runSourceMaintenance(rawOpts, 'review');
}

function runSourceMaintenance(rawOpts: unknown, mode: 'health' | 'review'): void {
  const opts = commandOptions(rawOpts);
  const { projectRoot } = resolveCliProjectContext();
  const report = sourceMaintenanceReport(projectRoot, {
    ...(mode === 'review' ? { base: stringOptionValue(opts, 'base') ?? 'HEAD' } : {}),
    coverage: stringOptionValue(opts, 'coverage'),
    scope: stringOptionValue(opts, 'scope'),
    includeTests: booleanOptionValue(opts, 'includeTests'),
    includeReferences: booleanOptionValue(opts, 'includeReferences'),
    includeGenerated: booleanOptionValue(opts, 'includeGenerated'),
    maxFiles: numberOptionValue(opts, 'maxFiles'),
  });
  if (booleanOptionValue(opts, 'json')) printJsonEnvelope(mode, [], opts, report);
  else
    renderSourceMaintenance(
      report,
      booleanOptionValue(opts, 'full') ? Infinity : (numberOptionValue(opts, 'limit') ?? (mode === 'health' ? 5 : 20)),
    );
  if (booleanOptionValue(opts, 'check')) {
    if (report.coverage.status === 'incomplete') process.exitCode = 2;
    else if (report.blockingFindingIds.length) process.exitCode = 1;
  }
}

export function renderSourceMaintenance(
  report: SourceMaintenanceReport,
  limit = report.mode === 'health' ? 5 : 20,
): void {
  renderMaintenanceCoverage(report);
  if (report.mode === 'review') renderChangedFunctions(report);
  renderMaintenanceSuppressions(report);
  console.log(`Blocking findings: ${report.blockingFindingIds.length}; raw findings remain visible below.`);
  if (report.mode === 'health' && limit !== Infinity) renderDependencyComponents(report, limit);
  renderModuleSubjects(report, limit);
  if (report.mode === 'review' || limit === Infinity) renderFindings(report, limit);
  console.log(
    'Recovery: use --scope <file-or-directory> for a subject, or --full for all findings, sites and supporting details. Exhaustive machine reports use --json --json-output <path>.',
  );
  if (report.affectedFiles.length)
    console.log(
      `\nAffected importers (${report.affectedFiles.length}):\n${report.affectedFiles.map((file) => `  ${file}`).join('\n')}`,
    );
  if (report.coverage.problems.length)
    console.log(`\nUnresolved coverage:\n${report.coverage.problems.map((problem) => `  ${problem}`).join('\n')}`);
  console.log(`\nInterpretation:\n${report.coverage.limits.map((item) => `  ${item}`).join('\n')}`);
  console.log(
    '\nPlan from exact implementations and consumers; preserve behavior, review candidates, run relevant tests, then rerun review. Metric reductions alone do not establish a better design.',
  );
}

function renderMaintenanceCoverage(report: SourceMaintenanceReport): void {
  console.log(
    `${report.mode === 'review' ? 'Change review' : 'Source health'} — current source, ${report.coverage.analyzedFiles}/${report.coverage.eligibleFiles} eligible files, ${report.coverage.analyzedFunctions} functions`,
  );
  if (report.base) console.log(`Base: ${report.base}; current source fingerprint: ${report.current}`);
  console.log(
    `Coverage: ${report.coverage.status}; ${report.coverage.excludedFiles} files excluded by language/path policy; ${report.coverage.unresolvedImports} missing or ambiguous internal imports.`,
  );
  console.log(
    `Exclusions: ${Object.entries(report.coverage.exclusions)
      .map(([reason, count]) => `${reason} ${count}`)
      .join('; ')}.`,
  );
  const dependencies = report.coverage.dependencies;
  console.log(
    `Import resolution: ${Object.entries(dependencies.resolutions)
      .map(([kind, count]) => `${kind} ${count}`)
      .join('; ')}.`,
  );
  console.log(
    `Import roles: ${dependencies.typeOnly} type-only; ${dependencies.test} test; ${dependencies.deferredOrCommonJs} dynamic/CommonJS. Production file-cycle checks use static value imports.`,
  );
  const architecture = report.architecture;
  console.log(
    architecture.configured
      ? `Declared groups: ${architecture.boundaries.length}; ${architecture.coverage.mappedFiles}/${architecture.coverage.totalFiles} files mapped. Dependency rules: ${architecture.policyCoverage.declaredRows}/${architecture.policyCoverage.totalBoundaries} rows declared; ${architecture.policyCoverage.missingRows.length} directions unknown. Group cycles: ${architecture.cycles.length}; these are not necessarily cycles between files.`
      : 'Architecture: no declared groups or dependency rules. Directory groupings identify locations; conceptual ownership remains unverified.',
  );
  const testCoverage = report.coverage.testCoverage;
  console.log(
    `Test coverage: ${testCoverage.requested ? 'requested' : 'not supplied'}; ${testCoverage.available} available, ${testCoverage.unavailable} unavailable function measurements.`,
  );
  for (const reason of testCoverage.reasons) console.log(`  ${reason}`);
}

function renderMaintenanceSuppressions(report: SourceMaintenanceReport): void {
  for (const decision of report.suppressionDecisions) {
    console.log(
      `Suppression ${decision.outcome}: ${decision.id ?? decision.check ?? 'unknown target'}${decision.reasons.length ? ` — ${decision.reasons.join('; ')}` : ''}`,
    );
  }
}

function renderChangedFunctions(report: SourceMaintenanceReport): void {
  console.log(`\nChanged source: ${report.changedFiles.length} files; ${report.functions.length} function records.`);
  if (report.configurationChanges.length)
    console.log(`Changed configuration: ${report.configurationChanges.join(', ')}`);
  if (report.relationshipChangedFiles.length)
    console.log(`Changed import relationships: ${report.relationshipChangedFiles.join(', ')}`);
  for (const change of report.functions) {
    const fn = (change.after ?? change.before)!;
    const metric =
      change.before && change.after
        ? `cyclomatic ${change.before.cyclomatic} → ${change.after.cyclomatic}, cognitive ${change.before.cognitive} → ${change.after.cognitive}`
        : `cyclomatic ${fn.cyclomatic}, cognitive ${fn.cognitive}`;
    const coverage =
      fn.coverage.status === 'available'
        ? `coverage ${Math.round(fn.coverage.fraction * 100)}%, CRAP ${fn.coverage.crap}`
        : `CRAP unavailable: ${fn.coverage.reason}`;
    console.log(`  ${change.status} ${fn.file}:${fn.startLine} ${fn.name} — ${metric}; ${coverage}`);
  }
}

function renderFindings(report: SourceMaintenanceReport, limit: number): void {
  console.log(`\nFindings: ${report.findings.length} (${Math.min(limit, report.findings.length)} shown)`);
  for (const finding of report.findings.slice(0, limit)) {
    renderFinding(finding, limit);
  }
}

function renderFinding(finding: SourceMaintenanceReport['findings'][number], limit: number): void {
  console.log(
    `  [${finding.status ? `${finding.status}; ` : ''}${finding.evidence}] ${finding.rule}: ${finding.summary}`,
  );
  for (const site of finding.sites.slice(0, limit === Infinity ? Infinity : 3))
    console.log(`    ${site.file}:${site.line}${site.name ? ` ${site.name}` : ''}`);
  if (limit === Infinity) for (const detail of finding.details) console.log(`    ${detail}`);
  else
    console.log(
      `    ${finding.sites.length} total sites; ${finding.details.length} supporting details available with --full.`,
    );
}

function renderModuleSubjects(report: SourceMaintenanceReport, limit: number): void {
  console.log(
    `\nPlanning subjects: ${report.modules.length} groups with ${report.findings.length} underlying findings (${Math.min(limit, report.modules.length)} groups shown).`,
  );
  const findings = new Map(report.findings.map((finding) => [finding.id, finding]));
  for (const group of planningSubjectOrder(report).slice(0, limit)) {
    console.log(
      `  ${group.id} [${group.basis}]: ${group.files.length} files, ${group.consumers.length} external consumer files, ${group.dependencies.length} external dependency files, ${group.findingIds.length} findings.`,
    );
    console.log(`    Files: ${moduleFileList(group.files, limit, '')}`);
    console.log(`    Consumers: ${moduleFileList(group.consumers, limit, 'none observed')}`);
    console.log(`    Dependencies: ${moduleFileList(group.dependencies, limit, 'none observed')}`);
    renderPrimaryModuleFindings(group, findings);
  }
}

function moduleFileList(files: readonly string[], limit: number, empty: string): string {
  const selected = files.slice(0, limit === Infinity ? Infinity : 3).join(', ') || empty;
  return selected + (files.length > 3 && limit !== Infinity ? ' …' : '');
}

function renderPrimaryModuleFindings(
  group: SourceMaintenanceReport['modules'][number],
  findings: ReadonlyMap<string, SourceMaintenanceReport['findings'][number]>,
): void {
  for (const id of group.primaryFindingIds.slice(0, 3)) {
    const finding = findings.get(id)!;
    console.log(
      `    [${finding.evidence}${finding.status ? '; ' + finding.status : ''}] ${finding.rule}: ${finding.summary}`,
    );
    for (const site of finding.sites.slice(0, 2))
      console.log(`      ${site.file}:${site.line}${site.name ? ' ' + site.name : ''}`);
  }
}

function renderDependencyComponents(report: SourceMaintenanceReport, limit: number): void {
  const assigned = new Set(report.modules.flatMap((group) => group.findingIds));
  const components = report.findings
    .filter((finding) => !assigned.has(finding.id))
    .sort((a, b) => Number(b.rule === 'dependency-cycle') - Number(a.rule === 'dependency-cycle'));
  if (!components.length) return;
  console.log(
    `\nDependency components: ${components.length} (${Math.min(limit, components.length)} shown; shared relationships, not defects attributed to the first member).`,
  );
  for (const finding of components.slice(0, limit)) {
    console.log(`  [${finding.evidence}] ${finding.summary}`);
    for (const site of finding.sites.slice(0, 3)) console.log(`    ${site.file}:${site.line}`);
    console.log(
      `    ${finding.sites.length} source sites and ${finding.details.length} supporting details; --full retains every observed component edge.`,
    );
  }
}

/** Surface the strongest available example of each finding kind before filling the remaining module slots. */
function planningSubjectOrder(report: SourceMaintenanceReport): SourceMaintenanceReport['modules'] {
  const owners = new Map(report.modules.flatMap((group) => group.primaryFindingIds.map((id) => [id, group] as const)));
  const represented = new Set<string>();
  const selected = new Set<SourceMaintenanceReport['modules'][number]>();
  for (const finding of report.findings) {
    const group = owners.get(finding.id);
    if (group && !represented.has(finding.rule)) {
      selected.add(group);
      represented.add(finding.rule);
    }
  }
  return [...selected, ...report.modules.filter((group) => !selected.has(group))];
}
