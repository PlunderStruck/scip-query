import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveIndexStoragePaths } from '../platform/cache-layout.js';
import { readSmallArtifactText } from '../platform/bounded-file.js';
import * as queries from '../queries/index.js';
import { loadProjectConfig } from './config.js';
import { GENERATED_AGENT_COMMAND_CATALOG } from './generated-agent-command-catalog.js';
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
    'scip-query separates two responsibilities: the agent decides what repository fact it needs, while the tool locates exact referents and reports compiler, runtime, data, state, temporal, contract, identity, ownership, and dependency evidence without guessing task relevance. The ordinary loop is locate an exact root, project explicitly chosen relationships, read behavior only for a named remaining gap, then stop when the requested claims are established.',
    '',
    '- Use scip-query for repository exploration, including literal search and exact source reads. Native tools are for applying edits, running checks, binary content, or a specific unsupported gap that scip-query has explicitly reported—not a parallel exploration workflow.',
    '- Before exploring, state the few material repository facts the answer depends on. Include behavior-changing predicates, authorization checks, data reshaping, hard bounds, runtime crossings, durable state changes, emitted notifications, returned values, relevant sibling outcomes, and externally visible ordering only when the request depends on them.',
    '- For end-to-end explanations, the installed scip-query skill maintains a private evidence ledger and audits the final answer as part of the same exploration workflow.',
    ...GENERATED_AGENT_COMMAND_CATALOG,
    '- Any exact symbol or `file:line` returned by a locator is immediately usable as a graph root. There is no required anchor-discovery phase and locator ordering never proves task relevance. For an end-to-end question, include the initiating owner as a root or request incoming execution capable of exposing it; do not assume a core type is the ingress. Locate independent roots together when the question already implies several participants.',
    '- A materialized evidence projection requires repeated `--symbol`, `--at`, or `--search` selectors plus one or more repeated `--edge <family>` flags, explicit `--direction incoming|outgoing|both`, `--depth <n>`, and `--max-edges <n>`. The agent chooses the relationships capable of establishing its claim; the CLI resolves identity, direction, evidence strength, provider support, and coverage. Use optional exact `--subtype <subtype>` and `--connecting` only when the selected roots themselves must be connected. Never request `complete`, `all`, or every family merely to discover what exists; use `--inventory-only` when only counts can determine the next bounded projection.',
    '- Treat execution calls and exact runtime handoffs as executable reachability. Dataflow, state, temporal, contract, identity, ownership, and dependency edges say what a path carries, changes, orders, constrains, identifies, contains, or relies on; they do not become call claims. Treat exact edges as facts only within their stated coverage and candidate edges as leads requiring source confirmation.',
    '- Read every packet as a coverage contract. `accounted` means the requested bounded projection reports every omission; `bounded` means requested edges were placed in stable recoverable folds by the output budget; `incomplete` means a selector or provider could not be resolved. None proves the user task complete, and missing output is no evidence of absence.',
    '- Prefer batched locators, projections, and gap reads. Query count measures exploration efficiency; it never makes a known recoverable material fact optional. Before drilling down, name the still-missing fact. Expand only a printed fold or exact adjacent identity that can establish it; batch independent roots and gaps instead of shuttling between abstraction levels, and repeat only while a named fact remains unresolved.',
    '- Use `scip-query inspect --symbol <symbol> --symbol <symbol> --at <file:line> --view behavior` for several named behavioral gaps. Connected behavior is already source evidence; do not reread lines it rendered. Use `scip-query code <symbol-or-range>` only when exact implementation syntax can change the decision. Do not replace these reads with `rg`, `grep`, `sed`, or `nl`.',
    '- For a multi-step mutation, preserve later compaction, rollback, and cleanup. For every event, log, or outbox write, preserve its operation and record identity. For coordination, state the lock scope and which checks and writes occur inside it. State whether interruption is prevented, atomic, rolled back, or repaired later. Resolve exact constant values when they can change the answer.',
    '- For a tiered policy or dispatcher, preserve the precedence of its tiers and the exact scope of every bypass; never imply that a later bypass can skip an earlier hard rejection unless the rendered condition proves it.',
    '- For a stateful owner, preserve its lifetime and sharing scope, including whether it is a singleton, shared registry, per-session instance, or per-invocation value.',
    '- Use `scip-query diff-impact` to map changed symbols and downstream consumers after a nontrivial edit.',
    '- Use `scip-query architecture` to inspect explicit structural rules.',
    '- Use `scip-query health` to find React, Vue, duplication, complexity, drift, and cleanup candidates.',
    '- Before claiming a complete relationship set or an absence, inspect coverage and use `--full` only when complete coverage can change the decision. A bounded or unsupported result cannot establish that no caller, route, branch, poller, or consumer exists.',
    '- Before claiming what every callsite passes, read the `trace` or `evidence` claim-support section. Only an eligible callsite-argument claim is backed by complete syntactic invocations; bounded context is not proof.',
    '- Prefer human output for agent reading. Use `--json --result-only` only for a programmatic consumer.',
    '- Never rerun a successful human command as JSON. Before each drilldown, name the still-unanswered fact and check whether an earlier packet already establishes it; if so, update the ledger or draft without another query. Stop when no unanswered fact remains because every additional reasoning step pays again for the accumulated context.',
    '- Before answering, compare the draft to selected statement-complete behavior and audit the final answer itself against every established ledger row. Explicitly state each material condition, outcome, qualifier, bound, sibling branch, and failure or cleanup behavior instead of relying on implication or a citation to carry an omitted clause. Preserve every behavior-changing predicate, returned default, separately merged field, cache invalidation, and cleanup effect. Do not collapse fields with different operations into a generic summary, and do not re-query evidence already in context.',
    '- With an explicit SCIP_QUERY_SESSION, a complete source unit, a byte-identical exact subset of a prior exact source read, or a graph unit/edge may be replaced by a visible receipt from the same index generation. Preview coverage never suppresses an exact unit; changed bytes, changed graph content, a new generation, or --reemit force full evidence.',
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
