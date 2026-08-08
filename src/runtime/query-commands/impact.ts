import * as queries from '../../queries/index.js';
import type { CommandDescriptor } from '../command-kit/command-descriptor-types.js';
import {
  agentContract,
  doc,
  fixedClaimFamily,
  mixedClaimContract,
  option,
  parseInteger,
  parseNumber,
  withJsonOption,
} from '../command-kit/command-spec-builders.js';
import {
  budgetedDbCommand,
  booleanOptionValue,
  dbCommand,
  definedLimitOption,
  definedNumberOption,
  numberOptionValue,
  printJsonEnvelope,
  stringArg,
  stringOptionValue,
} from '../command-kit/command-execution.js';
import { renderHeuristicNotice } from '../cli-support.js';
import { displayRange, render } from '../render.js';
import { symbolResolutionBefore, symbolResolutionEmptyMessage, withSymbolResolutionJson } from './symbol-resolution.js';

const handleAffected = dbCommand(({ db, args, opts }) => {
  const query = stringArg(args, 0);
  const full = booleanOptionValue(opts, 'full');
  const maxDepth = numberOptionValue(opts, 'maxDepth');
  if (full && maxDepth !== undefined) {
    throw new Error(
      '--full cannot be combined with --max-depth. Use --full for complete traversal or --max-depth N for a bounded traversal.',
    );
  }
  const result = queries.possibleImpactClosure(db, query, {
    maxDepth: full ? Number.MAX_SAFE_INTEGER : maxDepth,
    scope: stringOptionValue(opts, 'scope'),
  });
  const results = result.rows;
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('affected', args, opts, {
      ...withSymbolResolutionJson(db, query, results, 'affected'),
      coverage: result.coverage,
    });
    return;
  }
  if (results.length === 0) {
    return render.empty(
      symbolResolutionEmptyMessage(
        db,
        query,
        'No possible impacts found in the bounded reverse caller/reference closure.',
      ),
    );
  }
  symbolResolutionBefore(db, query);
  let prevDepth = -1;
  for (const r of results) {
    if (r.depth !== prevDepth) {
      console.log(`\n  ── Depth ${r.depth} ──`);
      prevDepth = r.depth;
    }
    console.log(`  ${r.file}  ${r.shortName}`);
  }
  console.log(
    `\n${results.length} possible-impact symbol(s) across ${new Set(results.map((r) => r.file)).size} files; reachability does not prove breakage.`,
  );
  console.log(`  coverage: ${result.coverage.status} — ${result.coverage.reasons.join(' ')}`);
});

const handleCoChange = budgetedDbCommand('co-change', ({ db, args, opts, budget }) => {
  const file = args[0] === undefined ? undefined : stringArg(args, 0);
  const full = booleanOptionValue(opts, 'full');
  const result = queries.coChange(db, file, {
    minTogether: definedNumberOption(opts, 'minTogether', 4),
    limit: definedLimitOption(opts, 'limit', 30),
    includeLinked: opts['all'] === true,
    scanLimit: budget.scanLimit,
    historyMode: full ? 'full' : 'bounded',
  });
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('co-change', args, opts, result, { analysisBudget: budget.analysisBudget });
    return;
  }
  if (!result.available) return render.empty('No git history available (not a repository, or git missing).');
  if (result.findings.length === 0) {
    return render.empty(
      file
        ? `No co-change partners found for ${file} in ${result.commitsAnalyzed} commits.`
        : `No hidden coupling found in ${result.commitsAnalyzed} commits.`,
    );
  }
  renderHeuristicNotice('co-change candidates');
  console.log(
    file
      ? `Co-change partners (${result.commitsAnalyzed} commits analyzed):\n`
      : `Hidden coupling — pairs that co-change with no dependency edge (${result.commitsAnalyzed} commits analyzed):\n`,
  );
  if (file && result.findings.some((finding) => finding.structurallyLinked || finding.declaredCouplingSuggestion)) {
    console.log(
      'note: file mode lists all historical partners; [dep edge]/[declared] pairs are excluded from hidden-coupling findings.\n',
    );
  }
  for (const finding of result.findings) {
    const linked = finding.structurallyLinked ? '  [dep edge]' : '';
    const partnerClass = `  [${finding.partnerClass}]`;
    const historyContext = `  [${finding.commitScope}/${finding.recency}]`;
    console.log(
      `  ${finding.together}x (${Math.round(finding.confidence * 100)}%)  ${finding.fileA}  <->  ${finding.fileB}${partnerClass}${historyContext}${linked}`,
    );
    console.log(
      `    history: ${finding.focusedTogether} focused, ${finding.broadTogether} broad-sweep (${Math.round(
        finding.broadCommitRatio * 100,
      )}% broad), ${finding.recentTogether} recent; last ${formatUnixDate(finding.lastTogetherAt)}`,
    );
    console.log(`    subjects: ${formatCoChangeSubjectContext(finding.subjectContext)}`);
    if (finding.declaredCouplingSuggestion) {
      console.log(
        `    declare coupling: ${finding.declaredCouplingSuggestion.name} (${finding.declaredCouplingSuggestion.reason})`,
      );
    }
  }
  console.log(`\n${result.findings.length} pair(s). Co-editing one side without the other is how drift starts.`);
});

function formatUnixDate(timestampSeconds: number): string {
  if (timestampSeconds <= 0) return 'unknown';
  return new Date(timestampSeconds * 1000).toISOString().slice(0, 10);
}

function formatCoChangeSubjectContext(context: {
  subjectLabels: readonly string[];
  issueRefs: readonly string[];
  sampleSubjects: readonly string[];
  externalIssueLabelStatus: string;
}): string {
  const labels = context.subjectLabels.length > 0 ? context.subjectLabels.slice(0, 5).join(', ') : 'none inferred';
  const refs = context.issueRefs.length > 0 ? context.issueRefs.slice(0, 5).join(', ') : 'none';
  const samples =
    context.sampleSubjects.length > 0
      ? context.sampleSubjects
          .slice(0, 3)
          .map((subject) => `"${subject}"`)
          .join('; ')
      : 'none';
  return `labels ${labels}; refs ${refs}; samples ${samples}; external issue/PR labels ${context.externalIssueLabelStatus}`;
}

const handleChangeSurface = budgetedDbCommand('change-surface', ({ db, args, opts, budget }) => {
  const result = queries.changeSurface(db, stringArg(args, 0), { semantic: budget.semantic });
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('change-surface', args, opts, result, { analysisBudget: budget.analysisBudget });
    return;
  }
  if (!result) return render.empty('File not found in index.');
  console.log(`File: ${result.file}`);
  console.log(`External consumers: ${result.totalExternalConsumers}`);
  if (result.fileRisk && result.fileRisk.reasons.length > 0) {
    console.log(
      `File risk factors (${result.fileRisk.coverage} metadata): ${result.fileRisk.reasons
        .map((reason) => `${reason.kind}: ${reason.detail}`)
        .join('; ')}`,
    );
  }
  console.log('');
  render.list(result.symbols, (s) => {
    const risk = s.riskLevel === 'high' ? ' *** HIGH RISK ***' : s.riskLevel === 'medium' ? ' * medium risk *' : '';
    const riskReasons = s.riskReasons ?? [];
    const reasons =
      riskReasons.length === 0
        ? ''
        : `  [why: ${riskReasons.map((reason) => `${reason.kind}: ${reason.detail}`).join('; ')}]`;
    return `  ${displayRange(s.startLine, s.endLine)}  ${s.shortName}  [${s.externalConsumers} consumers]${risk}${reasons}`;
  });
});

const handleIncompleteMigration = budgetedDbCommand('incomplete-migration', ({ db, args, opts, budget }) => {
  const result = queries.incompleteMigration(db, {
    base: stringOptionValue(opts, 'base'),
    minContainment: definedNumberOption(opts, 'minContainment', 0.7),
    maxHelpers: numberOptionValue(opts, 'maxHelpers'),
    limit: definedLimitOption(opts, 'limit', 20),
    scanLimit: budget.scanLimit,
    semantic: budget.semantic,
  });
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('incomplete-migration', args, opts, result, { analysisBudget: budget.analysisBudget });
    if (!result.available || result.findings.length > 0) process.exitCode = 1;
    return;
  }
  if (!result.available) {
    console.error(`error: ${result.note ?? 'Required Git history is unavailable.'}`);
    process.exitCode = 1;
    return;
  }
  if (result.changedFiles.length === 0) return render.empty(`No changes vs ${result.base}.`);
  console.log(
    `Incomplete migrations vs ${result.base}: ${result.changedFiles.length} changed file(s), ${result.helpersChecked} new helper(s) scored.`,
  );
  if (result.note) console.log(`  note: ${result.note}`);
  for (const skip of result.skipped) {
    console.log(`  skipped ${skip.helperShortName} (${skip.helperFile}): ${skip.reason}`);
  }
  if (result.findings.length === 0) {
    console.log('\nNo incomplete migrations detected.');
    return;
  }
  renderHeuristicNotice('incomplete migration candidates');
  for (const finding of result.findings) {
    console.log(`\n  ${finding.helperShortName}  (${finding.helperFile})`);
    console.log(
      `    helper shape: ${finding.helperShape} (${finding.specificHelperCalleeCount}/${finding.helperCalleeCount} specific callees)`,
    );
    console.log(`    wired into: ${finding.migratedFiles.join(', ')}`);
    for (const leftover of finding.leftovers) {
      console.log(
        `    un-migrated: ${Math.round(leftover.containment * 100)}% helper / ${Math.round(
          leftover.siteCoverage * 100,
        )}% site  [${leftover.migrationScope}]  ${leftover.shortName}  (${leftover.file})`,
      );
      console.log(`      scope: ${leftover.migrationScopeReasons.join('; ')}`);
      if (leftover.uniqueSiteCalleeCount > 0)
        console.log(`      extra site callees: ${leftover.uniqueSiteCalleeCount}`);
      console.log(`      shared: ${leftover.sharedCallees.join(', ')}`);
    }
  }
  console.log(
    `\n${result.findings.length} helper(s) with un-migrated sites. Finish the extraction or confirm the sites differ on purpose.`,
  );
});

export const impactQueryCommandDescriptors: CommandDescriptor[] = [
  {
    id: 'affected',
    command: 'affected <symbol>',
    description: 'Conservative reverse caller/reference closure of symbols that may be impacted by a change',
    agent: agentContract(
      'Which downstream symbols are statically reachable as possible change impacts?',
      'possible-impact symbol identities, files, and traversal depths; not predicted failures',
      ['symbol'],
      'bounded',
    ),
    options: withJsonOption([
      option('--full', 'Traverse without the default depth and per-frontier caller caps'),
      option('--max-depth <n>', 'Maximum traversal depth (default: 5)', parseInteger),
      option('-s, --scope <path>', 'Limit to files matching path'),
    ]),
    renderShape: 'custom',
    docs: doc('Impact'),
    handler: handleAffected,
  },
  {
    id: 'change-surface',
    command: 'change-surface <file>',
    description: 'Pre-change briefing: consumers, published API, operational roots, and explained change risk',
    agent: agentContract(
      'What public surface and consumers make this file risky to change?',
      'defined symbols, external consumer counts, and risk levels',
      ['file'],
      'bounded',
    ),
    options: withJsonOption([option('--full', 'Run unbounded semantic analysis on large indexes')]),
    budget: 'semantic',
    renderShape: 'list',
    docs: doc('Impact'),
    handler: handleChangeSurface,
  },
  {
    id: 'incomplete-migration',
    command: 'incomplete-migration',
    description:
      'Partially-completed extraction candidates: new helpers in the diff wired into some sites while similar un-migrated sites remain',
    agent: agentContract(
      'Did this diff leave a helper extraction only partly migrated?',
      'new helpers and similar unmigrated call sites',
      [],
      'bounded',
      'diff',
    ),
    options: withJsonOption([
      option('--base <ref>', 'Git ref to diff against (default: HEAD)'),
      option('--min-containment <n>', 'Minimum share of helper callees a site must contain (0-1)', parseNumber, 0.7),
      option('--max-helpers <n>', 'Maximum new helpers to score (default: all)', parseInteger),
      option('-n, --limit <n>', 'Maximum findings to report', parseInteger, 20),
      option('--full', 'Run unbounded git-history analysis on large indexes'),
    ]),
    heuristic: { label: 'incomplete migration candidates' },
    renderShape: 'custom',
    docs: doc('Impact', ['scip-query incomplete-migration', 'scip-query incomplete-migration --base origin/main']),
    handler: handleIncompleteMigration,
  },
  {
    id: 'co-change',
    command: 'co-change [file]',
    description: 'Files that change together in git history without a dependency edge — hidden coupling candidates',
    agent: agentContract(
      'Which files repeatedly change together without a declared dependency?',
      'file pairs, co-change counts, confidence, and history context',
      ['file'],
      'bounded',
      'repository',
    ),
    options: withJsonOption([
      option('--min-together <n>', 'Minimum commits where both files changed', parseInteger, 4),
      option('-n, --limit <n>', 'Maximum pairs to report', parseInteger, 30),
      option('--all', 'Include pairs that already have a dependency edge'),
      option('--full', 'Run unbounded analysis on large indexes'),
    ]),
    heuristic: { label: 'co-change candidates' },
    claims: mixedClaimContract(
      ['index-generation', 'live-workspace'],
      [
        fixedClaimFamily('historical-pairs', 'findings[]', 'change-history'),
        fixedClaimFamily('structural-link-classification', 'findings[].structurallyLinked', 'compiler-graph'),
      ],
    ),
    renderShape: 'custom',
    docs: doc('Impact', ['scip-query co-change', 'scip-query co-change src/runtime/config.ts']),
    handler: handleCoChange,
  },
];
