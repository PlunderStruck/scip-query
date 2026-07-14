import * as queries from '../../queries/index.js';
import type { DiffGateCheck } from '../../queries/impact/diff-gate.js';
import type { CommandDescriptor } from '../commands/command-descriptor-types.js';
import {
  collectValues,
  doc,
  option,
  parseInteger,
  parseNumber,
  withJsonOption,
} from '../commands/command-spec-builders.js';
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
} from '../commands/command-execution.js';
import { formatGateBlockReason, isStopHookReentry, readHookInput } from '../agent-setup.js';
import { formatLowResolutionNudges, formatUnresolvedStreakLine } from '../../queries/health/finding-outcome-ledger.js';
import { recordDiffGateOutcomes } from '../diff-gate-outcomes.js';
import { commandAnalysisBudget, formatAnalysisBudgetDisclosure, renderHeuristicNotice } from '../cli-support.js';
import { displayRange, displaySnippet, render } from '../render.js';
import { symbolResolutionBefore, symbolResolutionEmptyMessage, withSymbolResolutionJson } from './symbol-resolution.js';

const handleAffected = dbCommand(({ db, args, opts }) => {
  const query = stringArg(args, 0);
  const results = queries.affected(db, query, {
    maxDepth: definedNumberOption(opts, 'maxDepth', 5),
    scope: stringOptionValue(opts, 'scope'),
  });
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('affected', args, opts, withSymbolResolutionJson(db, query, results, 'affected'));
    return;
  }
  if (results.length === 0) {
    return render.empty(symbolResolutionEmptyMessage(db, query, 'No affected symbols found.'));
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
  console.log(`\n${results.length} affected symbol(s) across ${new Set(results.map((r) => r.file)).size} files.`);
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
  console.log(`External consumers: ${result.totalExternalConsumers}\n`);
  render.list(result.symbols, (s) => {
    const risk = s.riskLevel === 'high' ? ' *** HIGH RISK ***' : s.riskLevel === 'medium' ? ' * medium risk *' : '';
    return `  ${displayRange(s.startLine, s.endLine)}  ${s.shortName}  [${s.externalConsumers} consumers]${risk}`;
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
    if (result.available && result.findings.length > 0) process.exitCode = 1;
    return;
  }
  if (!result.available) return render.empty('No git history available (not a repository, or git missing).');
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

function parseSkipChecks(value: unknown): DiffGateCheck[] {
  const names = Array.isArray(value) ? (value as string[]) : [];
  const unknown = names.filter((name) => !(queries.DIFF_GATE_CHECKS as readonly string[]).includes(name));
  if (unknown.length > 0) {
    console.error(
      `error: unknown --skip check(s): ${unknown.join(', ')}. Valid checks: ${queries.DIFF_GATE_CHECKS.join(', ')}`,
    );
    process.exit(1);
  }
  return names as DiffGateCheck[];
}

const handleDiffGate = dbCommand(({ db, opts }) => {
  const hookMode = opts['hook'] === true;
  if (hookMode && isStopHookReentry(readHookInput())) {
    return; // this turn was already continued by a previous block — don't loop
  }
  const full = booleanOptionValue(opts, 'full');
  const budget = commandAnalysisBudget(db, 'diff-gate', full, {
    quiet: hookMode || booleanOptionValue(opts, 'json'),
  });
  const gateOptions = {
    base: stringOptionValue(opts, 'base'),
    minTogether: definedNumberOption(opts, 'minTogether', 6),
    maxEchoChecks: numberOptionValue(opts, 'maxEchoChecks'),
    maxHelpers: numberOptionValue(opts, 'maxHelpers'),
    includeBaseline: booleanOptionValue(opts, 'baseline'),
    scanLimit: budget.scanLimit,
    semantic: budget.semantic,
    historyMode: full ? 'full' : 'bounded',
    skip: parseSkipChecks(opts['skip']),
  } as const;
  const result = queries.diffGate(db, gateOptions);
  const blocking = queries.blockingFindings(result.findings);
  const gateFailed = queries.diffGateFailedClosed(result);
  const outcomes = recordDiffGateOutcomes(db, result, {
    replayGate: (baseCommit) => queries.diffGate(db, { ...gateOptions, base: baseCommit }),
  });
  if (outcomes.warning) console.error(`note: ${outcomes.warning}`);
  if (!hookMode && booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('diff-gate', [], opts, {
      exitCode: blocking.length > 0 || gateFailed ? 1 : 0,
      ...(gateFailed ? { gateError: 'git diff unavailable - zero checks ran; the gate fails closed' } : {}),
      advisoryFindingCount: result.findings.length - blocking.length,
      ...(budget.analysisBudget ? { analysisBudget: budget.analysisBudget } : {}),
      ...result,
    });
    if (blocking.length > 0 || gateFailed) process.exitCode = 1;
    return;
  }
  if (hookMode) {
    const { ledger, observed, now } = outcomes;

    // Hook contract (Claude Code and Codex): silent exit 0 = allow stop,
    // exit 2 with stderr = block and feed the reason back to the agent.
    // Advisory-only findings (e.g. twin-partner) never block the stop —
    // see the `advisory` field doc comment on DiffGateFinding.
    if (gateFailed) {
      console.error(
        'diff gate FAILED CLOSED: could not compute the git diff (diff too large, bad --base, or git error) - zero checks ran. Investigate with: scip-query diff-gate',
      );
      process.exitCode = 2;
      return;
    }
    if (blocking.length === 0) return;
    const streakLine = formatUnresolvedStreakLine(ledger, observed, now);
    const nudgeLines = formatLowResolutionNudges(ledger, result.checksRun);
    const budgetLine = formatAnalysisBudgetDisclosure(budget.analysisBudget);
    const lines = [
      ...(streakLine ? [streakLine] : []),
      formatGateBlockReason(result),
      ...nudgeLines,
      ...(budgetLine ? [budgetLine] : []),
    ];
    console.error(lines.join('\n'));
    process.exitCode = 2;
    return;
  }
  if (gateFailed) {
    console.error(
      'FAIL (gate error): could not compute the git diff - zero checks ran; the gate fails closed. Check --base and repository state.',
    );
    process.exitCode = 1;
    return;
  }
  if (result.changedFiles.length === 0) {
    return render.empty(result.note ?? `No changes vs ${result.base}.`);
  }
  console.log(
    `Diff gate vs ${result.base}: ${result.changedFiles.length} file(s), ${result.changedSymbols} symbol(s) changed.`,
  );
  const unattributed = result.attributionNotes.filter((note) => note.method === 'unattributed');
  if (unattributed.length > 0) {
    for (const file of [...new Set(unattributed.map((note) => note.file))]) {
      const count = unattributed.filter((note) => note.file === file).length;
      console.log(`note: ${count} changed line-range(s) in ${file} belong to no indexed symbol`);
    }
  }
  console.log(`Checks: ${result.checksRun.join(', ')}\n`);
  for (const skip of result.skipped) {
    console.log(`  skipped ${skip.check}: ${skip.reason}`);
  }
  if (result.findings.length === 0) {
    console.log('PASS: this change introduces no gate findings.');
    return;
  }
  renderHeuristicNotice('diff gate candidates');
  const multiFindingGroups = result.rootCauseGroups?.filter((group) => group.count > 1) ?? [];
  if (multiFindingGroups.length > 0) {
    console.log(`Root-cause groups (${multiFindingGroups.length}):`);
    for (const group of multiFindingGroups) {
      console.log(
        `  [${group.check}] ${group.count} finding(s), ${group.severity}${
          group.actionTier ? `, tier: ${group.actionTier}` : ''
        }`,
      );
      if (group.sourceAnalyzer || group.rootCauseKey) {
        console.log(
          `    source: ${group.sourceAnalyzer ?? group.check}${
            group.rootCauseKey ? `  root cause: ${group.rootCauseKey}` : ''
          }`,
        );
      }
      const files = [...new Set([...group.files, ...group.relatedFiles])].slice(0, 6);
      if (files.length > 0) console.log(`    files: ${files.join(', ')}`);
      console.log(`    -> ${group.remediation}`);
    }
    console.log('');
  }
  for (const finding of result.findings) {
    console.log(`  [${finding.check}]${finding.advisory ? ' (advisory)' : ''} ${finding.message}`);
    if (finding.partnerClass) {
      console.log(`    partner class: ${finding.partnerClass}`);
      for (const reason of finding.partnerClassReasons ?? []) console.log(`      reason: ${reason}`);
    }
    if (finding.citationKind) {
      console.log(
        `    citation kind: ${finding.citationKind}${finding.actionTier ? ` (tier: ${finding.actionTier})` : ''}`,
      );
    }
    for (const citedClaim of finding.citedClaims?.slice(0, 2) ?? []) {
      console.log(`    cited claim: ${displaySnippet(citedClaim)}`);
    }
    if (finding.declaredCouplingSuggestion) {
      console.log(
        `    declare coupling: ${finding.declaredCouplingSuggestion.name} (${finding.declaredCouplingSuggestion.reason})`,
      );
    }
    console.log(`    -> ${finding.remediation}`);
  }
  if (blocking.length === 0) {
    console.log(
      `\nPASS (advisory only): ${result.findings.length} advisory finding(s) recorded — none block this diff.`,
    );
    return;
  }
  const advisoryCount = result.findings.length - blocking.length;
  console.log(
    `\nFAIL: ${blocking.length} finding(s)${advisoryCount > 0 ? ` (+${advisoryCount} advisory)` : ''}, ${
      result.rootCauseGroups?.length ?? result.findings.length
    } root-cause group(s). Fix or knowingly accept before merging.`,
  );
  process.exitCode = 1;
});

export const impactQueryCommandDescriptors: CommandDescriptor[] = [
  {
    id: 'affected',
    command: 'affected <symbol>',
    description: 'Transitive closure of symbols that could break if this symbol changes',
    options: withJsonOption([
      option('--max-depth <n>', 'Maximum traversal depth', parseInteger, 5),
      option('-s, --scope <path>', 'Limit to files matching path'),
    ]),
    renderShape: 'custom',
    docs: doc('Impact'),
    handler: handleAffected,
  },
  {
    id: 'change-surface',
    command: 'change-surface <file>',
    description: 'Pre-change briefing: exports, consumers, and blast-radius risk',
    options: withJsonOption([option('--full', 'Run unbounded semantic analysis on large indexes')]),
    budget: 'semantic',
    renderShape: 'list',
    docs: doc('Impact'),
    handler: handleChangeSurface,
  },
  {
    id: 'diff-gate',
    command: 'diff-gate',
    description:
      'Gate the current diff: echo candidates, incomplete migrations, missing co-change partners, unedited twin partners (advisory), uncited doc updates, unused params, new dead symbols; exit 1 on blocking findings',
    options: [
      option('--base <ref>', 'Git ref to diff against (default: HEAD)'),
      option('--min-together <n>', 'Minimum historical co-changes for the partner check', parseInteger, 6),
      option('--max-echo-checks <n>', 'Maximum changed symbols to test for echoes (default: all)', parseInteger),
      option('--max-helpers <n>', 'Maximum new helpers to score for incomplete-migration (default: all)', parseInteger),
      option('--baseline', 'Also run the full health-baseline ratchet'),
      option('--full', 'Run unbounded semantic and git-history analysis on large indexes'),
      option(
        '--skip <check>',
        'Skip a check (repeatable): echo, incomplete-migration, co-change-partner, twin-partner, coverage-contract, doc-reference, unused-params, new-dead, baseline',
        collectValues,
        [],
      ),
      option('--hook', 'Agent Stop-hook mode: silent on pass, exit 2 with findings on stderr to block the stop'),
      option('--json', 'Output as JSON for programmatic consumption'),
    ],
    heuristic: { label: 'diff gate candidates' },
    renderShape: 'custom',
    docs: doc('Impact', ['scip-query diff-gate', 'scip-query diff-gate --base origin/main']),
    handler: handleDiffGate,
  },
  {
    id: 'incomplete-migration',
    command: 'incomplete-migration',
    description:
      'Partially-completed extraction candidates: new helpers in the diff wired into some sites while similar un-migrated sites remain',
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
    options: withJsonOption([
      option('--min-together <n>', 'Minimum commits where both files changed', parseInteger, 4),
      option('-n, --limit <n>', 'Maximum pairs to report', parseInteger, 30),
      option('--all', 'Include pairs that already have a dependency edge'),
      option('--full', 'Run unbounded analysis on large indexes'),
    ]),
    heuristic: { label: 'co-change candidates' },
    renderShape: 'custom',
    docs: doc('Impact', ['scip-query co-change', 'scip-query co-change src/runtime/config.ts']),
    handler: handleCoChange,
  },
];
