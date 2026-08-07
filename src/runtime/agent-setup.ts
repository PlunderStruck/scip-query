import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveIndexStoragePaths } from '../platform/cache-layout.js';
import { readSmallArtifactText } from '../platform/bounded-file.js';
import * as queries from '../queries/index.js';
import { loadProjectConfig } from './config.js';
import { getIndexFreshness } from './index-freshness.js';
import { openProjectDb } from './cli-context.js';
import {
  mutateTextFileRevisionAware,
  type RevisionedTextMutation,
  type RevisionedTextSnapshot,
} from './revisioned-file.js';

const MD_BLOCK_BEGIN = '<!-- scip-query:agent-setup:begin -->';
const MD_BLOCK_END = '<!-- scip-query:agent-setup:end -->';
const LEGACY_PRE_COMMIT_MARKER = '# scip-query:agent-setup';
const LOCAL_HOOK_TARGETS = ['.codex/hooks.json', '.claude/settings.local.json'] as const;
const EXCLUDE_BEGIN = '# scip-query:local-agent-hooks:begin';
const EXCLUDE_END = '# scip-query:local-agent-hooks:end';
const OWNED_COMMAND = 'hook-architecture-stop';

export interface SetupAgentResult {
  written: string[];
  unchanged: string[];
  skipped: Array<{ target: string; reason: string }>;
}

export type SetupAgentVerdict = 'ready' | 'partial' | 'blocked';

export function evaluateSetupAgentResult(result: SetupAgentResult): {
  verdict: SetupAgentVerdict;
  ready: number;
  skipped: number;
} {
  const ready = result.written.length + result.unchanged.length;
  const skipped = result.skipped.length;
  return {
    verdict: skipped === 0 ? 'ready' : ready === 0 ? 'blocked' : 'partial',
    ready,
    skipped,
  };
}

export interface RemoveAgentSetupResult {
  removed: string[];
  unchanged: string[];
  skipped: Array<{ target: string; reason: string }>;
}

export function setupAgent(
  projectRoot: string,
  opts: { architectureHook?: ArchitectureHookSetupOptions | false } = {},
): SetupAgentResult {
  const result: SetupAgentResult = { written: [], unchanged: [], skipped: [] };
  writeInstructionsBlock(projectRoot, result);
  if (opts.architectureHook !== false) installArchitectureStopHooks(projectRoot, result, opts.architectureHook);
  return result;
}

export function removeAgentSetup(projectRoot: string, opts: { dryRun?: boolean } = {}): RemoveAgentSetupResult {
  const result: RemoveAgentSetupResult = { removed: [], unchanged: [], skipped: [] };
  removeManagedBlock(projectRoot, 'AGENTS.md', opts, result);
  removeManagedBlock(projectRoot, 'CLAUDE.md', opts, result);
  removeArchitectureStopHooks(projectRoot, opts, result);
  removeLegacyPreCommitHook(projectRoot, opts, result);
  return result;
}

function writeInstructionsBlock(projectRoot: string, result: SetupAgentResult): void {
  const block = [
    MD_BLOCK_BEGIN,
    '## scip-query',
    '',
    'This repository uses scip-query as its primary code exploration surface.',
    '',
    'scip-query is the repository exploration sensor. Locate referents in exact indexed text; orient them by compiler identity and construct ownership; navigate typed compiler and runtime relationships; require every omitted direction to be emitted, recoverably folded, explicitly excluded, or reported unsupported; read connected behavior for the selected path; and retrieve exact current source only where the decision requires full implementation detail. Treat exact edges as facts within their reported coverage, candidates as leads, and missing output as no evidence of absence.',
    '',
    '- Use scip-query for repository exploration, including literal search and exact source reads. Native tools are for applying edits, running checks, binary content, or a specific unsupported gap that scip-query has explicitly reported—not a parallel exploration workflow.',
    "- For a cross-layer or end-to-end question, first reduce the question to the few material claims it asks you to establish. Material facts include every relevant behavior-changing predicate, authorization check, data reshaping, hard bound, runtime crossing, durable state change, emitted notification, and returned value on the selected causal path; preserve them in the final answer instead of summarizing them away. For a multi-step mutation, preserve the order of every externally visible state change plus later compaction, rollback, or cleanup. For every event, log, or outbox write, preserve its operation kind and record-identity fields. For coordination, state the lock's scope and which read/check/write steps occur inside it. For interrupted-update behavior, state whether the sequence is atomic, prevented, rolled back, or repaired later. Use one locator: `scip-query search <text>` only for a quoted exact source/runtime literal or exact compiler symbol; an unquoted domain term, feature name, or command name is not exact. Otherwise use `scip-query anchors '<complete question>'`. Anchor discovery mechanically attributes normalized repository words to compiler owners and groups them through bounded repository evidence; ranking is navigation help, not inferred relevance. Before applying a group-kind rule, reject any set whose displayed roots and matched terms omit an object, branch, or stage explicitly named by a material claim. Do not choose a set merely because it is connected. Choose the first ranked eligible set: for a cross-process or cross-protocol sequence, use the first `cross-boundary-flow` whose displayed producer, runtime key, and downstream owner match the requested operation; for an exhaustive \"which operations/callers can\" question, use the smallest `shared-callee-owners` set covering the candidate sibling owners, while remembering that common callees do not by themselves prove state-changing effects; otherwise use the smallest `connected-flow` whose displayed roots already cover every named material part. If no `connected-flow` does, use the smallest `parallel-paths` set that collectively covers those parts, even when the request describes one causal sequence; it batches disconnected evidence without claiming a causal edge. If no shown set covers the material claims, expand the anchor manifest instead of mapping a partial set. Anchor roots are locator evidence, not behavior evidence. Run the chosen set's printed `scip-query system-map` command unchanged and wait for transport completion before choosing any source inspection. The map and inspection are sequential, never parallel: while the map is running, poll that execution and do not launch `inspect`, `evidence`, `code`, or another repository query. The map labels exact causal targets as upstream callers, downstream callees, result-producing callbacks, or runtime producers/consumers without claiming they all matter. If one corresponds to a named missing material fact, copy the printed `Recommended one-shot drill batch` unchanged after the map. Never combine that batch with the exhaustive exact-source recovery command; the latter repeats every construct already represented by connected behavior and is only for a named syntax gap. Do not force both literal and symbol selectors: a source-owned search identity remains `--search`; use `--symbol` only for a printed compiler identity, and never pass the same loose term to both selectors. Read anchor status, the query connector graph, connected behavior, accounted frontiers, and query completion together. Connected behavior is already source evidence. Before any gap query, make a private evidence ledger for every explicit anchor and preserve every relevant sibling branch outcome; sibling branches are jointly required behavior, not alternative search results. If its lines and transitions establish every material claim, answer immediately even when unrelated recovery commands remain. Otherwise name the fact still missing and resolve it with one batched `inspect` or exact-source query; never expand every region merely because the map offers a recovery command. The normal allowance is one locator, one map, and at most one batched gap query. Before sending, audit the draft itself against the material claims: evidence seen but left implicit is not recovered, and returned file/line identities must be copied exactly rather than reconstructed.",
    '- Optional causal recovery is folded by default. Only after naming a material fact the connected behavior does not establish should you inspect the specific upstream caller, downstream callee, result callback, or runtime participant printed for that gap. Resolve category-changing gaps first—process versus cross-process, atomic versus later repair, durable versus merely written—before adding detail to behavior already established. Use exact printed targets directly in one batched `scip-query inspect`. If a named callee is additional or ambiguous and no exact target was printed, rerun the original `system-map` command with `--gap-callee <name> --gap-recovery-only`, then run the exact batched inspect it prints. The CLI resolves identity and causal direction; it does not infer relevance.',
    "- Use `scip-query search <text>` for exact repository text. Use `scip-query anchors '<question>'` when the task does not supply a trustworthy literal or symbol. Search always reports exact total cardinality. Small results list every identity; broad results stop lower-ranked identities before traversal and retain ranked recovery scopes. Use `--full-literal-traversal` only when every exact match can change the decision. Anchor discovery reports matched and unmatched query terms, compiler-owned candidate sets, bounded graph connections, and exact map commands. Narrow or expand either surface only when omitted evidence can change the decision.",
    '- After the first map, use `scip-query inspect --symbol <symbol> --symbol <symbol> --at <file:line> --view behavior` to resolve several named gaps in one coverage-diverse packet. Repeat the selector flags; positional selectors are not accepted. Compact units remain raw source; larger units use a complete normalized outline only when it is cheaper; unsupported statements remain verbatim. A function-start selector is not a valid focus when its behavior exceeds the packet ceiling: if inspect requires focus, use interior file:line locations already visible in the map and do not follow with `--full`. Inspect also refuses an accidentally broad exact-source packet before emitting it. Override neither ceiling unless every omitted statement or the omitted syntax itself can change the decision. Use `code` for the few exact implementations whose details can change the decision.',
    '- Use `scip-query code` only for complete exact reads whose full implementation can change the decision. Symbols and ranges return source; file selectors return exported source (or top-level definitions when no explicit export surface exists) plus same-file referenced definitions and a complete omitted-local ledger. Batch only independently necessary exact units, cite the absolute line numbers already returned, and do not re-read those ranges with `nl`, `sed`, `rg`, or another scip-query command. A refusal means the request was too broad and no partial source was emitted; narrow to the exact units still needed before deciding whether every split remains necessary.',
    "- Read inspect's selector cardinality, per-channel evidence coverage, omission ledger, and query completion. `selection-complete` means only that this inspect query returned everything it requested; `connector-complete` means only that the requested anchor paths were proved; `frontier-accounted` means withheld directions are explicitly recoverable; `coverage-incomplete` means required evidence remains unknown. None says the user's task is finished. Drill several relevant omission groups together, and use `--full` only when every omitted unit can change the decision. Coverage expansion is optional drilldown, not a transport continuation.",
    '- Use `scip-query evidence <symbol> --include definition,references,callers,callees` to compose one exact symbol and its material relationships in one response.',
    '- Use `scip-query context <target>` to map flow, consumers, reuse options, constraints, and relevant source before a nonlocal change.',
    '- Do not inventory one file or symbol at a time. Batch known gaps with `inspect`, then add a focused query only when a named uncertainty remains.',
    '- Use focused graph commands when a compiler-resolved relationship can change the plan. Do not rerun an unchanged read-only query.',
    '- Use `scip-query diff-impact` to map changed symbols and downstream consumers after a nontrivial edit.',
    '- Use `scip-query architecture` to inspect explicit structural rules.',
    '- Use `scip-query health` to find React, Vue, duplication, complexity, drift, and cleanup candidates.',
    '- Treat compiler-graph and exact runtime-boundary findings as facts within stated coverage. Candidate boundary links and heuristic findings need source confirmation and do not drive default traversal.',
    '- Before claiming a complete relationship set or an absence, inspect coverage and use `--full` only when complete coverage can change the decision. A bounded result cannot establish that no caller, route, branch, poller, or consumer exists.',
    '- Before claiming what every callsite passes, read the `trace` or `evidence` claim-support section. Only an eligible callsite-argument claim is backed by complete syntactic invocations; bounded context is not proof.',
    '- Prefer human output for agent reading. Use `--json --result-only` only for a programmatic consumer.',
    '- Never rerun a successful human command as JSON. Before each drilldown, name the still-unanswered fact and stop when no such fact remains; every additional reasoning step pays again for the accumulated context.',
    '- With an explicit SCIP_QUERY_SESSION, a complete source unit or graph unit/edge may be replaced only by a visible receipt for content-identical evidence from the same index generation. Partial source coverage never suppresses an exact unit; changed bytes, changed graph content, a new generation, or --reemit force full evidence.',
    '- If output emits `Continue exactly:`, run that command unchanged until transport is complete.',
    '- When architecture rules are configured and clean, setup installs one checkout-local Stop hook. It checks architecture only after indexed source changes.',
    '- Commit relevant `.scipquery/suppressions/*.json` records with the change. Do not commit local agent-tool settings.',
    MD_BLOCK_END,
  ].join('\n');

  upsertManagedBlock(projectRoot, 'AGENTS.md', block, result);

  const shim = [MD_BLOCK_BEGIN, '@AGENTS.md', MD_BLOCK_END].join('\n');
  upsertManagedBlock(projectRoot, 'CLAUDE.md', shim, result, (current) => {
    return current.includes('@AGENTS.md') && !current.includes(MD_BLOCK_BEGIN);
  });
}

function upsertManagedBlock(
  projectRoot: string,
  name: string,
  block: string,
  result: SetupAgentResult,
  preserveCurrent?: (current: string) => boolean,
): void {
  const path = join(projectRoot, name);
  let preserved = false;
  const mutation = mutateManagedFile(path, name, result, (snapshot) => {
    if (preserveCurrent?.(snapshot.text)) {
      preserved = true;
      return { kind: 'unchanged' };
    }
    const next = upsertManagedBlockText(snapshot.text, block);
    return next === snapshot.text
      ? { kind: 'unchanged' }
      : { kind: 'write', text: next, ...(!snapshot.revision.exists ? { mode: 0o644 } : {}) };
  });
  if (!mutation) return;
  if (!mutation.changed || preserved) result.unchanged.push(name);
  else result.written.push(name);
}

function removeManagedBlock(
  projectRoot: string,
  name: string,
  opts: { dryRun?: boolean },
  result: RemoveAgentSetupResult,
): void {
  const path = join(projectRoot, name);
  if (opts.dryRun) {
    if (!existsSync(path)) {
      result.unchanged.push(name);
      return;
    }
    try {
      const current = readSmallArtifactText(path, 'agent instruction file');
      if (!current.includes(MD_BLOCK_BEGIN)) result.unchanged.push(name);
      else {
        removeManagedBlockText(current);
        result.removed.push(name);
      }
    } catch (error) {
      result.skipped.push({ target: name, reason: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  const mutation = mutateManagedFile(path, name, result, (snapshot) => {
    if (!snapshot.revision.exists || !snapshot.text.includes(MD_BLOCK_BEGIN)) return { kind: 'unchanged' };
    const next = removeManagedBlockText(snapshot.text);
    return next.length === 0 ? { kind: 'delete' } : { kind: 'write', text: next };
  });
  if (!mutation) return;
  if (mutation.changed) result.removed.push(name);
  else result.unchanged.push(name);
}

function upsertManagedBlockText(current: string, block: string): string {
  const markers = assertManagedMarkerShape(current);
  if (markers === 'present') {
    const pattern = new RegExp(`${MD_BLOCK_BEGIN}[\\s\\S]*?${MD_BLOCK_END}`);
    return current.replace(pattern, block);
  }
  return current.length > 0 ? `${current.replace(/\n*$/, '\n\n')}${block}\n` : `${block}\n`;
}

function removeManagedBlockText(current: string): string {
  assertManagedMarkerShape(current);
  const pattern = new RegExp(`${MD_BLOCK_BEGIN}[\\s\\S]*?${MD_BLOCK_END}`);
  const next = current
    .replace(pattern, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return next.length === 0 ? '' : `${next}\n`;
}

function assertManagedMarkerShape(current: string): 'absent' | 'present' {
  const begins = current.split(MD_BLOCK_BEGIN).length - 1;
  const ends = current.split(MD_BLOCK_END).length - 1;
  if (begins === 0 && ends === 0) return 'absent';
  if (begins === 1 && ends === 1 && current.indexOf(MD_BLOCK_BEGIN) < current.indexOf(MD_BLOCK_END)) {
    return 'present';
  }
  throw new Error('managed scip-query markers are incomplete, duplicated, or out of order');
}

function mutateManagedFile(
  path: string,
  label: string,
  result: SetupAgentResult | RemoveAgentSetupResult,
  transform: (snapshot: RevisionedTextSnapshot) => RevisionedTextMutation,
): ReturnType<typeof mutateTextFileRevisionAware> | undefined {
  try {
    return mutateTextFileRevisionAware(path, transform, { maxRetries: 0 });
  } catch (error) {
    result.skipped.push({ target: label, reason: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

function removeLegacyPreCommitHook(
  projectRoot: string,
  opts: { dryRun?: boolean },
  result: RemoveAgentSetupResult,
): void {
  const label = '.git/hooks/pre-commit';
  const path = join(projectRoot, label);
  if (!existsSync(path)) {
    result.unchanged.push(label);
    return;
  }
  const current = readSmallArtifactText(path, 'pre-commit hook');
  if (!current.includes(LEGACY_PRE_COMMIT_MARKER)) {
    result.skipped.push({ target: label, reason: 'pre-commit hook is not managed by scip-query' });
    return;
  }
  if (opts.dryRun) {
    result.removed.push(label);
    return;
  }
  const mutation = mutateManagedFile(path, label, result, () => ({ kind: 'delete' }));
  if (mutation?.changed) result.removed.push(label);
}

interface CommandHook {
  type: 'command';
  command: string;
  timeout?: number;
  statusMessage?: string;
}

interface HookGroup {
  matcher?: string;
  hooks: CommandHook[];
}

export interface AgentHookConfig {
  hooks?: { Stop?: HookGroup[]; [event: string]: HookGroup[] | undefined };
  [key: string]: unknown;
}

export type ArchitectureHookReadiness =
  | { state: 'not-configured' }
  | { state: 'ready' }
  | { state: 'blocked'; reason: string };

export interface ArchitectureHookSetupOptions {
  commandPrefix?: string;
  inspectReadiness?: (projectRoot: string) => ArchitectureHookReadiness;
}

export function installArchitectureStopHooks(
  projectRoot: string,
  result: SetupAgentResult,
  options: ArchitectureHookSetupOptions = {},
): void {
  const readiness = (options.inspectReadiness ?? inspectArchitectureHookReadiness)(projectRoot);
  if (readiness.state === 'not-configured') return;
  if (readiness.state === 'blocked') {
    result.skipped.push({ target: 'architecture Stop hook', reason: readiness.reason });
    return;
  }

  const commandPrefix = options.commandPrefix ?? 'scip-query';
  for (const relativePath of LOCAL_HOOK_TARGETS) {
    if (isGitTracked(projectRoot, relativePath)) {
      result.skipped.push({
        target: relativePath,
        reason: 'tracked repository config; the checkout-local hook installer will not modify it',
      });
      continue;
    }
    mutateHookFile(join(projectRoot, relativePath), relativePath, result, (current) =>
      mergeArchitectureStopHookConfig(current, commandPrefix),
    );
  }
  ensureLocalHookExcludes(projectRoot, result);
}

export function removeArchitectureStopHooks(
  projectRoot: string,
  options: { dryRun?: boolean } = {},
  result: RemoveAgentSetupResult,
): void {
  for (const relativePath of LOCAL_HOOK_TARGETS) {
    const path = join(projectRoot, relativePath);
    if (!existsSync(path)) continue;
    if (isGitTracked(projectRoot, relativePath)) {
      result.skipped.push({
        target: relativePath,
        reason: 'tracked repository config; the checkout-local hook remover will not modify it',
      });
      continue;
    }
    if (options.dryRun) {
      try {
        const current = parseHookConfig(path);
        if (JSON.stringify(removeArchitectureStopHookConfig(current)) !== JSON.stringify(current)) {
          result.removed.push(relativePath);
        }
      } catch (error) {
        result.skipped.push({ target: relativePath, reason: errorMessage(error) });
      }
      continue;
    }
    mutateHookFile(path, relativePath, result, removeArchitectureStopHookConfig, true);
  }
}

export function inspectArchitectureHookReadiness(projectRoot: string): ArchitectureHookReadiness {
  const config = loadProjectConfig(projectRoot);
  if (!config.architecture || config.architecture.boundaries.length === 0) return { state: 'not-configured' };

  const paths = resolveIndexStoragePaths(projectRoot, config);
  const freshness = getIndexFreshness(projectRoot, config, paths);
  if (freshness.state !== 'fresh') {
    return {
      state: 'blocked',
      reason: `the index is ${freshness.state}; refresh it before installing a persistent architecture grader`,
    };
  }

  let db;
  try {
    db = openProjectDb(projectRoot);
    const findings = queries.architectureFindingIdentities(queries.architecture(db));
    if (findings.length > 0) {
      return {
        state: 'blocked',
        reason:
          `the current architecture baseline has ${findings.length} enforced violation(s); ` +
          'make the declared policy clean before installing the Stop hook',
      };
    }
    return { state: 'ready' };
  } catch (error) {
    return { state: 'blocked', reason: errorMessage(error) };
  } finally {
    db?.close();
  }
}

export function mergeArchitectureStopHookConfig(
  config: AgentHookConfig,
  commandPrefix = 'scip-query',
): AgentHookConfig {
  const hooks = validHooks(config.hooks);
  const stopGroups = Array.isArray(hooks.Stop) ? hooks.Stop : [];
  return {
    ...config,
    hooks: {
      ...hooks,
      Stop: [
        ...pruneOwnedHookGroups(stopGroups),
        {
          hooks: [
            {
              type: 'command',
              command: `${commandPrefix} ${OWNED_COMMAND}`,
              timeout: 120,
              statusMessage: 'Checking architecture boundaries',
            },
          ],
        },
      ],
    },
  };
}

export function removeArchitectureStopHookConfig(config: AgentHookConfig): AgentHookConfig {
  const hooks = validHooks(config.hooks);
  const stopGroups = Array.isArray(hooks.Stop) ? hooks.Stop : [];
  const nextStop = pruneOwnedHookGroups(stopGroups);
  const nextHooks = { ...hooks };
  if (nextStop.length > 0) nextHooks.Stop = nextStop;
  else delete nextHooks.Stop;
  const next = { ...config };
  if (Object.keys(nextHooks).length > 0) next.hooks = nextHooks;
  else delete next.hooks;
  return next;
}

function validHooks(value: AgentHookConfig['hooks']): NonNullable<AgentHookConfig['hooks']> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function pruneOwnedHookGroups(groups: HookGroup[]): HookGroup[] {
  return groups
    .map((group) => ({
      ...group,
      hooks: Array.isArray(group.hooks) ? group.hooks.filter((hook) => !isOwnedHook(hook)) : [],
    }))
    .filter((group) => group.hooks.length > 0);
}

function isOwnedHook(hook: unknown): hook is CommandHook {
  if (!hook || typeof hook !== 'object') return false;
  const command = (hook as { command?: unknown }).command;
  return typeof command === 'string' && new RegExp(`(?:^|\\s)${OWNED_COMMAND}$`, 'u').test(command);
}

function mutateHookFile(
  path: string,
  label: string,
  result: SetupAgentResult | RemoveAgentSetupResult,
  transform: (current: AgentHookConfig) => AgentHookConfig,
  removing = false,
): void {
  try {
    const mutation = mutateTextFileRevisionAware(path, (snapshot): RevisionedTextMutation => {
      const current = snapshot.revision.exists ? parseHookText(snapshot.text, path) : {};
      const next = transform(current);
      if (JSON.stringify(next) === JSON.stringify(current)) return { kind: 'unchanged' };
      if (removing && Object.keys(next).length === 0) return { kind: 'delete' };
      return { kind: 'write', text: `${JSON.stringify(next, null, 2)}\n`, mode: 0o600 };
    });
    if (mutation.changed) {
      if ('written' in result) result.written.push(label);
      else result.removed.push(label);
    } else if (!removing) {
      result.unchanged.push(label);
    }
  } catch (error) {
    result.skipped.push({ target: label, reason: errorMessage(error) });
  }
}

function parseHookConfig(path: string): AgentHookConfig {
  return parseHookText(readSmallArtifactText(path, 'agent hook settings'), path);
}

function parseHookText(text: string, path: string): AgentHookConfig {
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Cannot update ${path}: the hook config is not a JSON object.`);
  }
  return value as AgentHookConfig;
}

function isGitTracked(projectRoot: string, relativePath: string): boolean {
  try {
    execFileSync('git', ['-C', projectRoot, 'ls-files', '--error-unmatch', '--', relativePath], {
      stdio: 'ignore',
      timeout: 5_000,
      killSignal: 'SIGKILL',
    });
    return true;
  } catch {
    return false;
  }
}

function ensureLocalHookExcludes(projectRoot: string, result: SetupAgentResult): void {
  const excludePath = join(projectRoot, '.git', 'info', 'exclude');
  if (!existsSync(dirname(excludePath))) {
    result.skipped.push({
      target: '.git/info/exclude',
      reason: 'Git metadata was not found; local hook files may appear as untracked',
    });
    return;
  }
  try {
    mutateTextFileRevisionAware(excludePath, (snapshot) => {
      const pattern = new RegExp(`${EXCLUDE_BEGIN}[\\s\\S]*?${EXCLUDE_END}\\n?`, 'gu');
      const withoutOwned = snapshot.text.replace(pattern, '').replace(/\n*$/u, '');
      const block = [EXCLUDE_BEGIN, ...LOCAL_HOOK_TARGETS.map((path) => `/${path}`), EXCLUDE_END].join('\n');
      const next = `${withoutOwned}${withoutOwned ? '\n\n' : ''}${block}\n`;
      return next === snapshot.text ? { kind: 'unchanged' } : { kind: 'write', text: next, mode: 0o644 };
    });
  } catch (error) {
    result.skipped.push({ target: '.git/info/exclude', reason: errorMessage(error) });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
