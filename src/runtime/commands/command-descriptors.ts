import type { CommandDescriptor } from './command-descriptor-types.js';
import {
  collectValues,
  doc,
  option,
  parseIntegerLoose,
  parsePositiveInteger,
  withJsonOption,
} from './command-spec-builders.js';
import { DIFF_IMPACT_BATCH_COMMAND, HEALTH_PHASE_COMMAND } from '../cli-support.js';
import { handleAgentHookContext, handleAgentHookStop } from '../agent-hooks.js';
import { BUILTIN_SKILLS } from '../setup.js';
import * as handlers from './command-handlers.js';
import { orderedQueryCommandDescriptors } from './query-command-specs.js';

const queryCommandsBeforeDiffImpact = orderedQueryCommandDescriptors.slice(0, queryIndexAfter('plan-context'));
const queryCommandsBeforeHealth = orderedQueryCommandDescriptors.slice(
  queryIndex('drift'),
  queryIndexAfter('self-audit'),
);
const queryCommandsBeforeMaintenance = orderedQueryCommandDescriptors.slice(
  queryIndex('convergence'),
  queryIndexAfter('slice'),
);
const queryCommandsAfterMaintenance = orderedQueryCommandDescriptors.slice(queryIndex('redundant-reexports'));

export const commandDescriptors: CommandDescriptor[] = [
  {
    id: 'reindex',
    command: 'reindex',
    description: 'Index the codebase and convert to SQLite',
    options: [
      option('-l, --language <lang>', 'Index only this language (can be repeated)', collectValues, []),
      option('--pnpm-workspaces', 'Enable pnpm workspace support (TypeScript)'),
      option('--force', 'Rebuild even if source inputs are unchanged'),
      option('--allow-partial', 'Write an incomplete index when one or more detected languages fail'),
      option('--indexer-concurrency <n>', 'Number of language indexers to run at once', parsePositiveInteger),
      option('--json', 'Output as JSON, including per-shard reuse diagnostics'),
    ],
    renderShape: 'custom',
    docs: doc('Indexing', ['scip-query reindex']),
    handler: handlers.handleReindex,
  },
  {
    id: 'augment-sources',
    command: 'augment-sources',
    description: 'Add source files skipped by upstream SCIP indexers to the SQLite documents table',
    renderShape: 'custom',
    docs: doc('Indexing'),
    handler: handlers.handleAugmentSources,
  },
  {
    id: 'augment-vue',
    command: 'augment-vue',
    description: 'Add compiler-resolved Vue SFC references to the SQLite index using Volar',
    options: [option('--project <tsconfig>', 'Vue tsconfig path', undefined, 'frontend/tsconfig.scip.json')],
    renderShape: 'custom',
    docs: doc('Indexing'),
    handler: handlers.handleAugmentVue,
  },
  ...queryCommandsBeforeDiffImpact,
  {
    id: DIFF_IMPACT_BATCH_COMMAND,
    command: DIFF_IMPACT_BATCH_COMMAND,
    description: 'Internal diff-impact batch worker',
    hidden: true,
    options: [option('--base <ref>', 'Git ref to diff against (default: HEAD)')],
    renderShape: 'custom',
    handler: handlers.handleDiffImpactBatch,
  },
  {
    id: 'diff-impact',
    command: 'diff-impact',
    description: 'Compute changed symbols and downstream consumers from current git diff',
    options: withJsonOption([option('--base <ref>', 'Git ref to diff against (default: HEAD)')]),
    renderShape: 'custom',
    docs: doc('Impact'),
    handler: handlers.handleDiffImpact,
  },
  ...queryCommandsBeforeHealth,
  {
    id: HEALTH_PHASE_COMMAND,
    command: HEALTH_PHASE_COMMAND,
    description: 'Internal health phase worker',
    hidden: true,
    arguments: [{ name: '<phase>' }],
    options: [
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--full', 'Run unbounded candidate analyses on large indexes'),
    ],
    renderShape: 'custom',
    handler: handlers.handleHealthPhase,
  },
  {
    id: 'health',
    command: 'health',
    description: 'Composite codebase health report with prioritized action list',
    options: [
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--full', 'Run unbounded candidate analyses on large indexes'),
      option('--json', 'Output as JSON for programmatic consumption'),
      option('--baseline', 'Compare findings against the committed baseline; exit 1 on new findings'),
      option('--write-baseline', 'Snapshot current finding identities to the baseline file'),
    ],
    renderShape: 'custom',
    docs: doc('Health', ['scip-query health --json', 'scip-query health --baseline']),
    handler: handlers.handleHealth,
  },
  {
    id: 'bench',
    command: 'bench',
    description: 'Benchmark indexing and command runtimes for this repository',
    options: [
      option('--json', 'Output as JSON for programmatic consumption'),
      option('--cold-index', 'Temporarily clear this project index cache and measure a cold rebuild'),
      option('--include-heavy', 'Include expensive full-detector commands in the command matrix'),
      option('--command <cmd>', 'Benchmark a specific scip-query command (can be repeated)', collectValues, []),
      option('--timeout-ms <n>', 'Per-command timeout in milliseconds', parsePositiveInteger, 180000),
      option('--progress', 'Print benchmark command start/finish progress to stderr'),
      option('--profile', 'Enable low-overhead phase profiling in benchmarked commands'),
      option('--profile-out <path>', 'Append benchmark and phase profile events as JSONL'),
    ],
    renderShape: 'custom',
    docs: doc('Maintenance', ['scip-query bench', 'scip-query bench --json --cold-index']),
    handler: handlers.handleBench,
  },
  {
    id: 'work-audit',
    command: 'work-audit <profile>',
    description: 'Rank exact repeated computations in a profiling JSONL file by measured avoidable time',
    options: [
      option('--top <n>', 'Maximum repeated-work groups to show', parsePositiveInteger, 20),
      option('--json', 'Output as JSON for programmatic consumption'),
    ],
    evidence: 'mixed',
    renderShape: 'custom',
    docs: doc('Maintenance', ['scip-query work-audit profile.jsonl', 'scip-query work-audit profile.jsonl --json']),
    handler: handlers.handleWorkAudit,
  },
  {
    id: 'typescript-semantic-compare',
    command: 'typescript-semantic-compare',
    description: 'Compare tsserver reference answers against the ts-morph baseline',
    hidden: true,
    options: [
      option('-s, --scope <path>', 'Limit compared definitions to files matching path'),
      option('--limit <n>', 'Maximum definitions to compare unless --full is set', parsePositiveInteger),
      option('--max-mismatches <n>', 'Maximum mismatch details to include in output', parseIntegerLoose),
      option('--full', 'Compare every indexed TypeScript-like definition'),
      option('--json', 'Output as JSON for programmatic consumption'),
    ],
    evidence: 'mixed',
    renderShape: 'custom',
    handler: handlers.handleTypeScriptSemanticCompare,
  },
  ...queryCommandsBeforeMaintenance,
  {
    id: 'install-skills',
    command: 'install-skills',
    description: `Install skills (${BUILTIN_SKILLS.join(', ')}) into Claude Code, Codex, and shared agent roots`,
    renderShape: 'custom',
    docs: doc('Maintenance'),
    handler: handlers.handleInstallSkills,
  },
  {
    id: 'setup-hooks',
    command: 'setup-hooks',
    description: 'Install or refresh project-local Codex and Claude Code lifecycle hooks',
    options: [
      option('--shared', 'Deprecated compatibility flag; hooks remain checkout-local and untracked'),
      option('--remove', 'Remove managed project hooks and remember the opt-out'),
      option('--force', 'Reinstall hooks even after a previous --remove opt-out'),
      option('--json', 'Output as JSON for programmatic consumption'),
    ],
    renderShape: 'custom',
    docs: doc('Maintenance', ['scip-query setup-hooks', 'scip-query setup-hooks --json']),
    handler: handlers.handleSetupHooks,
  },
  {
    id: 'hook-context',
    command: 'hook-context',
    description: 'Internal agent lifecycle hook context renderer',
    hidden: true,
    renderShape: 'custom',
    handler: handleAgentHookContext,
  },
  {
    id: 'hook-stop',
    command: 'hook-stop',
    description: 'Internal agent Stop hook wrapper for diff-gate',
    hidden: true,
    renderShape: 'custom',
    handler: handleAgentHookStop,
  },
  {
    id: 'check-deps',
    command: 'check-deps',
    description: 'Check whether scip-query and the detected language indexers are actually runnable',
    renderShape: 'custom',
    docs: doc('Maintenance'),
    handler: handlers.handleCheckDeps,
  },
  {
    id: 'capabilities',
    command: 'capabilities',
    description: 'Report which evidence and verification capabilities are available in this project',
    options: [
      option('--matrix', 'Render the project capability matrix (default output)'),
      option('--json', 'Output as JSON for programmatic consumption'),
    ],
    renderShape: 'custom',
    docs: doc('Maintenance'),
    handler: handlers.handleCapabilities,
  },
  {
    id: 'capability-matrix',
    command: 'capability-matrix',
    description: 'Deprecated alias for capabilities --matrix',
    options: [option('--json', 'Output as JSON for programmatic consumption')],
    renderShape: 'custom',
    docs: doc('Maintenance'),
    handler: handlers.handleCapabilityMatrix,
  },
  ...queryCommandsAfterMaintenance,
  {
    id: 'init',
    command: 'init',
    description: 'Create a .scipquery.json config file for this project',
    renderShape: 'custom',
    docs: doc('Maintenance'),
    handler: handlers.handleInit,
  },
  {
    id: 'config-validate',
    command: 'config-validate',
    description: 'Validate .scipquery.json, including structured suppressions and declared coupling groups',
    options: [option('--json', 'Output as JSON for programmatic consumption')],
    renderShape: 'custom',
    docs: doc('Maintenance', ['scip-query config-validate']),
    handler: handlers.handleConfigValidate,
  },
  {
    id: 'suppress',
    command: 'suppress <id>',
    description: 'Record an accepted finding as a file under .scipquery/suppressions/ with a required reason',
    options: withJsonOption([
      option('--reason <text>', 'Required human reason for accepting the finding'),
      option('--check <check>', 'Optional detector/check name to narrow the suppression'),
      option('--file <path>', 'Optional file path to narrow the suppression'),
      option('--expires-at <iso>', 'Optional ISO date after which the suppression expires'),
    ]),
    renderShape: 'custom',
    docs: doc('Maintenance', ['scip-query suppress SQABC123DEF456 --reason "intentional boundary"']),
    handler: handlers.handleSuppress,
  },
  {
    id: 'effectiveness',
    command: 'effectiveness',
    description:
      'Per-check effectiveness from the committed outcome ledger: caught, same-HEAD verified fixes, suppressed, unverified disappearances, and precision',
    options: withJsonOption([
      option('--since <window>', 'Only count findings first caught in this window (30d, 12w, or an ISO date)'),
      option('--check <check>', 'Restrict to one diff-gate check'),
    ]),
    renderShape: 'custom',
    docs: doc('Maintenance', ['scip-query effectiveness --since 30d', 'scip-query effectiveness --check echo --json']),
    handler: handlers.handleEffectiveness,
  },
  {
    id: 'doctor',
    command: 'doctor',
    description: 'Diagnose config, index freshness, dependency readiness, and project capabilities',
    options: [option('--json', 'Output as JSON for programmatic consumption')],
    renderShape: 'custom',
    docs: doc('Maintenance'),
    handler: handlers.handleDoctor,
  },
  {
    id: 'setup',
    command: 'setup',
    description:
      'Bootstrap this project: enable automatic indexing, install agent skills, refresh the index, verify capabilities, and report health',
    options: withJsonOption([
      option('--guided', 'Open the interactive checklist (the default in a terminal)'),
      option('--yes', 'Accept recommended setup defaults without prompting'),
      option('--git-hook', 'Also install a git pre-commit hook that runs diff-gate'),
      option('--no-hooks', 'Skip Codex and Claude Code lifecycle hook installation'),
      option('--no-skills', 'Skip user-level agent skill installation'),
      option('--no-health', 'Skip the optional full health audit and dossier'),
      option('--dossier-dir <path>', 'Directory for generated setup health dossier files'),
    ]),
    renderShape: 'custom',
    docs: doc('Maintenance', ['scip-query setup', 'scip-query setup --json']),
    handler: handlers.handleSetup,
  },
  {
    id: 'setup-agent',
    command: 'setup-agent',
    description:
      'Seed agent guidance for this project: AGENTS.md/CLAUDE.md block pointing agents at the scip-query skills and diff gate, plus an optional git pre-commit backstop',
    options: [option('--git-hook', 'Also install a git pre-commit hook that runs diff-gate')],
    renderShape: 'custom',
    docs: doc('Maintenance', ['scip-query setup-agent', 'scip-query setup-agent --git-hook']),
    handler: handlers.handleSetupAgent,
  },
  {
    id: 'setup-ci',
    command: 'setup-ci',
    description: 'Write a GitHub Actions workflow that runs scip-query reindex and diff-gate on pull requests',
    options: [
      option('--force', 'Overwrite an existing workflow'),
      option('--dry-run', 'Print the workflow without writing it'),
    ],
    renderShape: 'custom',
    docs: doc('Maintenance', ['scip-query setup-ci']),
    handler: handlers.handleSetupCi,
  },
  {
    id: 'uninstall',
    command: 'uninstall',
    description: 'Remove scip-query-owned skill links, project hooks, and managed agent setup blocks',
    options: withJsonOption([
      option('--global', 'Remove scip-query-owned skill symlinks from user-level agent skill roots'),
      option('--project', 'Remove project-local hooks and managed AGENTS.md/CLAUDE.md blocks'),
      option('--dry-run', 'List what would be removed without changing files'),
    ]),
    renderShape: 'custom',
    docs: doc('Maintenance', ['scip-query uninstall --dry-run', 'scip-query uninstall --project']),
    handler: handlers.handleUninstall,
  },
  {
    id: 'watch',
    command: 'watch',
    description: 'Watch in the foreground or manage the per-project background refresh service',
    options: withJsonOption([
      option('--daemon', 'Ensure the demand-started background service is running'),
      option('--status', 'Show background/foreground watcher state'),
      option('--stop', 'Stop the watcher or background service for this project'),
      option('--debounce <ms>', 'Ms to wait after last change (default: 250)', parseIntegerLoose),
      option('--cooldown <ms>', 'Min ms between reindexes; 0 disables spacing (default: 0)', parseIntegerLoose),
      option('--git-poll <ms>', 'Ms between Git HEAD/index checks (default: 2000)', parseIntegerLoose),
      option(
        '--idle-timeout <ms>',
        'Ms before clean-idle daemon exit; 0 keeps it running (default: 600000)',
        parseIntegerLoose,
      ),
    ]),
    renderShape: 'custom',
    docs: doc('Maintenance', [
      'scip-query watch',
      'scip-query watch --daemon',
      'scip-query watch --status --json',
      'scip-query watch --stop',
    ]),
    handler: handlers.handleWatch,
  },
  {
    id: 'status',
    command: 'status',
    description: 'Show index status for this project',
    options: [
      option('--json', 'Output as JSON for programmatic consumption'),
      option('--capabilities', 'Include the project capability matrix'),
    ],
    renderShape: 'custom',
    docs: doc('Maintenance'),
    handler: handlers.handleStatus,
  },
];

function queryIndex(id: string): number {
  const index = orderedQueryCommandDescriptors.findIndex((descriptor) => descriptor.id === id);
  if (index < 0) throw new Error(`Ordered query command descriptor is missing: ${id}`);
  return index;
}

function queryIndexAfter(id: string): number {
  return queryIndex(id) + 1;
}
