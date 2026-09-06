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
  const { projectRoot, config } = resolveCliProjectContext();
  const report = sourceMaintenanceReport(projectRoot, {
    ...(mode === 'review' ? { base: stringOptionValue(opts, 'base') ?? 'HEAD' } : {}),
    coverage: stringOptionValue(opts, 'coverage'),
    scope: stringOptionValue(opts, 'scope'),
    includeTests: booleanOptionValue(opts, 'includeTests'),
    maxFiles: numberOptionValue(opts, 'maxFiles'),
    architecture: config.architecture,
  });
  if (booleanOptionValue(opts, 'json')) printJsonEnvelope(mode, [], opts, report);
  else
    renderSourceMaintenance(
      report,
      booleanOptionValue(opts, 'full') ? Infinity : (numberOptionValue(opts, 'limit') ?? 20),
    );
  if (booleanOptionValue(opts, 'check')) {
    if (report.coverage.status === 'incomplete') process.exitCode = 2;
    else if (
      report.findings.some(
        (finding) =>
          finding.evidence === 'derived' &&
          (mode === 'health' || finding.status === 'introduced' || finding.status === 'worsened'),
      )
    )
      process.exitCode = 1;
  }
}

export function renderSourceMaintenance(report: SourceMaintenanceReport, limit = 20): void {
  console.log(
    `${report.mode === 'review' ? 'Change review' : 'Source health'} — current source, ${report.coverage.analyzedFiles}/${report.coverage.eligibleFiles} eligible files, ${report.coverage.analyzedFunctions} functions`,
  );
  if (report.base) console.log(`Base: ${report.base}; current source fingerprint: ${report.current}`);
  console.log(
    `Coverage: ${report.coverage.status}; ${report.coverage.excludedFiles} files excluded by language/path policy; ${report.coverage.unresolvedImports} imports outside resolved relative-file coverage.`,
  );
  if (report.mode === 'review') {
    console.log(`\nChanged source: ${report.changedFiles.length} files; ${report.functions.length} function records.`);
    for (const change of report.functions) {
      const fn = (change.after ?? change.before)!;
      const metric =
        change.before && change.after
          ? `cyclomatic ${change.before.cyclomatic} → ${change.after.cyclomatic}, cognitive ${change.before.cognitive} → ${change.after.cognitive}`
          : `cyclomatic ${fn.cyclomatic}, cognitive ${fn.cognitive}`;
      const coverage =
        fn.coverage.status === 'available'
          ? `coverage ${Math.round(fn.coverage.fraction! * 100)}%, CRAP ${fn.coverage.crap}`
          : `CRAP unavailable: ${fn.coverage.reason}`;
      console.log(`  ${change.status} ${fn.file}:${fn.startLine} ${fn.name} — ${metric}; ${coverage}`);
    }
  }
  console.log(`\nFindings: ${report.findings.length} (${Math.min(limit, report.findings.length)} shown)`);
  for (const finding of report.findings.slice(0, limit)) {
    console.log(
      `  [${finding.status ? `${finding.status}; ` : ''}${finding.evidence}] ${finding.rule}: ${finding.summary}`,
    );
    for (const site of finding.sites) console.log(`    ${site.file}:${site.line}${site.name ? ` ${site.name}` : ''}`);
    for (const detail of finding.details) console.log(`    ${detail}`);
  }
  if (report.findings.length > limit)
    console.log('More findings omitted from this display. Run the same command with --full to show all findings.');
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
