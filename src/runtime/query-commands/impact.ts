import * as queries from '../../queries/index.js';
import type { DiffGateCheck } from '../../queries/diff-gate.js';
import type { CommandDescriptor } from '../command-descriptor-types.js';
import { collectValues, doc, option, parseInteger, parseNumber } from '../command-spec-builders.js';
import {
  budgetedDbCommand,
  dbCommand,
  definedNumberOption,
  numberOptionValue,
  stringArg,
  stringOptionValue,
} from '../command-execution.js';
import { semanticCalleeRowCount } from '../../storage/evidence-cache.js';
import { formatGateBlockReason, isStopHookReentry, readHookInput } from '../agent-setup.js';
import { isLargeCommandIndex } from '../cli-support.js';
import { displayRange, render } from '../render.js';

const handleAffected = dbCommand(({ db, args, opts }) => {
  const results = queries.affected(db, stringArg(args, 0), {
    maxDepth: definedNumberOption(opts, 'maxDepth', 5),
    scope: stringOptionValue(opts, 'scope'),
  });
  if (results.length === 0) return render.empty('No affected symbols found.');
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

const handleCoChange = dbCommand(({ db, args, opts }) => {
  const file = args[0] === undefined ? undefined : stringArg(args, 0);
  const result = queries.coChange(db, file, {
    minTogether: definedNumberOption(opts, 'minTogether', 4),
    limit: definedNumberOption(opts, 'limit', 30),
    includeLinked: opts['all'] === true,
  });
  if (!result.available) return render.empty('No git history available (not a repository, or git missing).');
  if (result.findings.length === 0) {
    return render.empty(file
      ? `No co-change partners found for ${file} in ${result.commitsAnalyzed} commits.`
      : `No hidden coupling found in ${result.commitsAnalyzed} commits.`);
  }
  console.log(file
    ? `Co-change partners (${result.commitsAnalyzed} commits analyzed):\n`
    : `Hidden coupling — pairs that co-change with no dependency edge (${result.commitsAnalyzed} commits analyzed):\n`);
  for (const finding of result.findings) {
    const linked = finding.structurallyLinked ? '  [dep edge]' : '';
    console.log(`  ${finding.together}x (${Math.round(finding.confidence * 100)}%)  ${finding.fileA}  <->  ${finding.fileB}${linked}`);
  }
  console.log(`\n${result.findings.length} pair(s). Co-editing one side without the other is how drift starts.`);
});

const handleChangeSurface = budgetedDbCommand('change-surface', ({ db, args, budget }) => {
  const result = queries.changeSurface(db, stringArg(args, 0), { semantic: budget.semantic });
  if (!result) return render.empty('File not found in index.');
  console.log(`File: ${result.file}`);
  console.log(`External consumers: ${result.totalExternalConsumers}\n`);
  render.list(result.symbols, (s) => {
    const risk = s.riskLevel === 'high' ? ' *** HIGH RISK ***' : s.riskLevel === 'medium' ? ' * medium risk *' : '';
    return `  ${displayRange(s.startLine, s.endLine)}  ${s.shortName}  [${s.externalConsumers} consumers]${risk}`;
  });
});

const handleIncompleteMigration = dbCommand(({ db, opts }) => {
  const result = queries.incompleteMigration(db, {
    base: stringOptionValue(opts, 'base'),
    minContainment: definedNumberOption(opts, 'minContainment', 0.7),
    maxHelpers: numberOptionValue(opts, 'maxHelpers'),
    limit: definedNumberOption(opts, 'limit', 20),
  });
  if (!result.available) return render.empty('No git history available (not a repository, or git missing).');
  if (result.changedFiles.length === 0) return render.empty(`No changes vs ${result.base}.`);
  console.log(`Incomplete migrations vs ${result.base}: ${result.changedFiles.length} changed file(s), ${result.helpersChecked} new helper(s) scored.`);
  if (result.note) console.log(`  note: ${result.note}`);
  for (const skip of result.skipped) {
    console.log(`  skipped ${skip.helperShortName} (${skip.helperFile}): ${skip.reason}`);
  }
  if (result.findings.length === 0) {
    console.log('\nNo incomplete migrations detected.');
    return;
  }
  for (const finding of result.findings) {
    console.log(`\n  ${finding.helperShortName}  (${finding.helperFile})`);
    console.log(`    wired into: ${finding.migratedFiles.join(', ')}`);
    for (const leftover of finding.leftovers) {
      console.log(`    un-migrated: ${Math.round(leftover.containment * 100)}%  ${leftover.shortName}  (${leftover.file})`);
      console.log(`      shared: ${leftover.sharedCallees.join(', ')}`);
    }
  }
  console.log(`\n${result.findings.length} helper(s) with un-migrated sites. Finish the extraction or confirm the sites differ on purpose.`);
});

function parseSkipChecks(value: unknown): DiffGateCheck[] {
  const names = Array.isArray(value) ? (value as string[]) : [];
  const unknown = names.filter((name) => !(queries.DIFF_GATE_CHECKS as readonly string[]).includes(name));
  if (unknown.length > 0) {
    console.error(`error: unknown --skip check(s): ${unknown.join(', ')}. Valid checks: ${queries.DIFF_GATE_CHECKS.join(', ')}`);
    process.exit(1);
  }
  return names as DiffGateCheck[];
}

const handleDiffGate = dbCommand(({ db, opts }) => {
  const hookMode = opts['hook'] === true;
  if (hookMode && isStopHookReentry(readHookInput())) {
    return; // this turn was already continued by a previous block — don't loop
  }
  // Full coverage means a one-time semantic pass over every production
  // callable; on a large index with no evidence cache yet, say so instead of
  // looking hung. Re-runs only re-analyze changed files.
  if (!hookMode && isLargeCommandIndex(db) && semanticCalleeRowCount(db) === 0) {
    console.error(
      'Large index with a cold evidence cache: this first run computes semantic callee evidence '
      + 'for every production callable and can take minutes. Re-runs are incremental (evidence.db).',
    );
  }
  const result = queries.diffGate(db, {
    base: stringOptionValue(opts, 'base'),
    minTogether: definedNumberOption(opts, 'minTogether', 6),
    maxEchoChecks: numberOptionValue(opts, 'maxEchoChecks'),
    maxHelpers: numberOptionValue(opts, 'maxHelpers'),
    skip: parseSkipChecks(opts['skip']),
  });
  if (hookMode) {
    // Hook contract (Claude Code and Codex): silent exit 0 = allow stop,
    // exit 2 with stderr = block and feed the reason back to the agent.
    if (result.findings.length === 0) return;
    console.error(formatGateBlockReason(result));
    process.exitCode = 2;
    return;
  }
  if (result.changedFiles.length === 0) {
    return render.empty(result.note ?? `No changes vs ${result.base}.`);
  }
  console.log(`Diff gate vs ${result.base}: ${result.changedFiles.length} file(s), ${result.changedSymbols} symbol(s) changed.`);
  console.log(`Checks: ${result.checksRun.join(', ')}\n`);
  for (const skip of result.skipped) {
    console.log(`  skipped ${skip.check}: ${skip.reason}`);
  }
  if (result.findings.length === 0) {
    console.log('PASS: this change introduces no gate findings.');
    return;
  }
  for (const finding of result.findings) {
    console.log(`  [${finding.check}] ${finding.message}`);
    console.log(`    -> ${finding.remediation}`);
  }
  console.log(`\nFAIL: ${result.findings.length} finding(s). Fix or knowingly accept before merging.`);
  process.exitCode = 1;
});

export const impactQueryCommandDescriptors: CommandDescriptor[] = [
  {
    id: 'affected',
    command: 'affected <symbol>',
    description: 'Transitive closure of symbols that could break if this symbol changes',
    options: [
      option('--max-depth <n>', 'Maximum traversal depth', parseInteger, 5),
      option('-s, --scope <path>', 'Limit to files matching path'),
    ],
    renderShape: 'custom',
    docs: doc('Impact'),
    handler: handleAffected,
  },
  {
    id: 'change-surface',
    command: 'change-surface <file>',
    description: 'Pre-change briefing: exports, consumers, and blast-radius risk',
    options: [option('--full', 'Run unbounded semantic analysis on large indexes')],
    budget: 'semantic',
    renderShape: 'list',
    docs: doc('Impact'),
    handler: handleChangeSurface,
  },
  {
    id: 'diff-gate',
    command: 'diff-gate',
    description: 'Gate the current diff: echo candidates, incomplete migrations, missing co-change partners, uncited doc updates, unused params, new dead symbols; exit 1 on findings',
    options: [
      option('--base <ref>', 'Git ref to diff against (default: HEAD)'),
      option('--min-together <n>', 'Minimum historical co-changes for the partner check', parseInteger, 6),
      option('--max-echo-checks <n>', 'Maximum changed symbols to test for echoes (default: all)', parseInteger),
      option('--max-helpers <n>', 'Maximum new helpers to score for incomplete-migration (default: all)', parseInteger),
      option('--skip <check>', 'Skip a check (repeatable): echo, incomplete-migration, co-change-partner, doc-reference, unused-params, new-dead, baseline', collectValues, []),
      option('--hook', 'Agent Stop-hook mode: silent on pass, exit 2 with findings on stderr to block the stop'),
    ],
    heuristic: { label: 'diff gate candidates' },
    renderShape: 'custom',
    docs: doc('Impact', ['scip-query diff-gate', 'scip-query diff-gate --base origin/main']),
    handler: handleDiffGate,
  },
  {
    id: 'incomplete-migration',
    command: 'incomplete-migration',
    description: 'Partially-completed extraction candidates: new helpers in the diff wired into some sites while similar un-migrated sites remain',
    options: [
      option('--base <ref>', 'Git ref to diff against (default: HEAD)'),
      option('--min-containment <n>', 'Minimum share of helper callees a site must contain (0-1)', parseNumber, 0.7),
      option('--max-helpers <n>', 'Maximum new helpers to score (default: all)', parseInteger),
      option('-n, --limit <n>', 'Maximum findings to report', parseInteger, 20),
    ],
    heuristic: { label: 'incomplete migration candidates' },
    renderShape: 'custom',
    docs: doc('Impact', ['scip-query incomplete-migration', 'scip-query incomplete-migration --base origin/main']),
    handler: handleIncompleteMigration,
  },
  {
    id: 'co-change',
    command: 'co-change [file]',
    description: 'Files that change together in git history without a dependency edge — hidden coupling candidates',
    options: [
      option('--min-together <n>', 'Minimum commits where both files changed', parseInteger, 4),
      option('-n, --limit <n>', 'Maximum pairs to report', parseInteger, 30),
      option('--all', 'Include pairs that already have a dependency edge'),
    ],
    heuristic: { label: 'co-change candidates' },
    renderShape: 'custom',
    docs: doc('Impact', ['scip-query co-change', 'scip-query co-change src/runtime/config.ts']),
    handler: handleCoChange,
  },
];
