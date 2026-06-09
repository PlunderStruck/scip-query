import * as queries from '../../queries/index.js';
import type { CommandDescriptor } from '../command-descriptor-types.js';
import { doc, option, parseInteger } from '../command-spec-builders.js';
import {
  budgetedDbCommand,
  dbCommand,
  definedNumberOption,
  stringArg,
  stringOptionValue,
} from '../command-execution.js';
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

const handleDiffGate = dbCommand(({ db, opts }) => {
  const result = queries.diffGate(db, {
    base: stringOptionValue(opts, 'base'),
    minTogether: definedNumberOption(opts, 'minTogether', 6),
    maxEchoChecks: definedNumberOption(opts, 'maxEchoChecks', 10),
  });
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
    description: 'Gate the current diff: echo candidates, missing co-change partners, uncited doc updates, unused params, new dead symbols; exit 1 on findings',
    options: [
      option('--base <ref>', 'Git ref to diff against (default: HEAD)'),
      option('--min-together <n>', 'Minimum historical co-changes for the partner check', parseInteger, 6),
      option('--max-echo-checks <n>', 'Maximum changed symbols to test for echoes', parseInteger, 10),
    ],
    heuristic: { label: 'diff gate candidates' },
    renderShape: 'custom',
    docs: doc('Impact', ['scip-query diff-gate', 'scip-query diff-gate --base origin/main']),
    handler: handleDiffGate,
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
