/**
 * Agent-integration lifecycle: makes scip-query's checks reach coding agents
 * through the two artifacts every agent understands, with no per-tool config:
 *
 * - an AGENTS.md/CLAUDE.md instructions block (every agent reads one of
 *   these), seeded by `setupAgent()`, and
 * - an opt-in git pre-commit hook running `scip-query diff-gate` — the
 *   agent-agnostic backstop that fires whoever (or whatever) wrote the diff.
 *
 * Skills remain the primary routing layer (see skills/scip-query). For users
 * who want in-session enforcement, `diff-gate --hook` speaks the turn-end
 * hook contract shared by Claude Code, Codex, and Gemini CLI (JSON on stdin
 * with stop_hook_active, exit 2 + stderr blocks the turn) — this module owns
 * its stdin/formatting helpers, but deliberately does NOT write any tool's
 * hook config: those schemas are three independent implementations, and
 * silently-drifting config is worse than asking users to wire one line.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  readSmallArtifactText,
  readTextFileDescriptorWithinLimit,
  SMALL_ARTIFACT_MAX_BYTES,
} from '../platform/bounded-file.js';
import { blockingFindings } from '../queries/impact/diff-gate.js';
import type { DiffGateResult } from '../queries/impact/diff-gate.js';
import {
  mutateTextFileRevisionAware,
  type RevisionedTextMutation,
  type RevisionedTextSnapshot,
} from './revisioned-file.js';

const MD_BLOCK_BEGIN = '<!-- scip-query:agent-setup:begin -->';
const MD_BLOCK_END = '<!-- scip-query:agent-setup:end -->';
const PRE_COMMIT_MARKER = '# scip-query:agent-setup';

// ── Hook-side helpers (used by `diff-gate --hook`) ─────────────

/** Read piped stdin synchronously; '' when run interactively (TTY) or empty. */
export function readHookInput(): string {
  if (process.stdin.isTTY) return '';
  try {
    return readTextFileDescriptorWithinLimit(0, {
      maxBytes: SMALL_ARTIFACT_MAX_BYTES,
      inputKind: 'agent hook input',
    });
  } catch {
    return '';
  }
}

/**
 * True when this turn was already continued by a previous block from this
 * hook — blocking again would loop the agent forever.
 */
export function isStopHookReentry(hookInput: string): boolean {
  if (!hookInput.trim()) return false;
  try {
    const payload = JSON.parse(hookInput) as { stop_hook_active?: unknown };
    return payload.stop_hook_active === true;
  } catch {
    return false;
  }
}

/** Compact, agent-facing reason for blocking the stop. */
export function formatGateBlockReason(result: DiffGateResult): string {
  const blocking = blockingFindings(result.findings);
  const advisoryCount = result.findings.length - blocking.length;
  const groupCount = result.rootCauseGroups?.length ?? result.findings.length;
  const lines = [
    `scip-query diff-gate found ${blocking.length} issue(s) in ${groupCount} root-cause group(s) in this diff` +
      (advisoryCount > 0 ? ` (+${advisoryCount} advisory, non-blocking)` : '') +
      ` — fix or knowingly accept them before finishing:`,
  ];
  const multiFindingGroups = result.rootCauseGroups?.filter((group) => group.count > 1) ?? [];
  for (const group of multiFindingGroups) {
    lines.push(`- group [${group.check}] ${group.count} finding(s): ${group.message}`);
    lines.push(`  -> ${group.remediation}`);
  }
  for (const finding of result.findings) {
    lines.push(`- [${finding.check}]${finding.advisory ? ' (advisory)' : ''} ${finding.message}`);
    lines.push(`  -> ${finding.remediation}`);
  }
  return lines.join('\n');
}

// ── Project setup (`scip-query setup-agent`) ───────────────────

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

// scip-query: ignore-stale — reviewed S1 owned contract; agent setup removal returns this named result.
export interface RemoveAgentSetupResult {
  removed: string[];
  unchanged: string[];
  skipped: Array<{ target: string; reason: string }>;
}

export function setupAgent(projectRoot: string, opts: { gitHook?: boolean } = {}): SetupAgentResult {
  const result: SetupAgentResult = { written: [], unchanged: [], skipped: [] };

  writeInstructionsBlock(projectRoot, result);

  if (opts.gitHook) {
    writeGitPreCommitHook(projectRoot, result);
  }

  return result;
}

export function removeAgentSetup(projectRoot: string, opts: { dryRun?: boolean } = {}): RemoveAgentSetupResult {
  const result: RemoveAgentSetupResult = { removed: [], unchanged: [], skipped: [] };
  removeManagedBlock(projectRoot, 'AGENTS.md', opts, result);
  removeManagedBlock(projectRoot, 'CLAUDE.md', opts, result);
  removeGitPreCommitHook(projectRoot, opts, result);
  return result;
}

/**
 * Seed the agent instructions. AGENTS.md gets the canonical managed block
 * (the cross-tool standard file: Codex, Cursor, Gemini, opencode, ...).
 * Claude Code does NOT read AGENTS.md natively (anthropics/claude-code#6235),
 * so CLAUDE.md gets a managed `@AGENTS.md` import shim — the ecosystem-
 * standard bridge that Claude Code expands at load time. Only the content
 * between our markers is ever touched; user content is preserved.
 */
function writeInstructionsBlock(projectRoot: string, result: SetupAgentResult): void {
  const block = [
    MD_BLOCK_BEGIN,
    '## scip-query',
    '',
    'This repo is indexed by scip-query (compiler-resolved code intelligence).',
    '',
    '- Use native search and file reads for literal text and source. Use scip-query when a claim depends on compiler-resolved identity, references, callers, dependencies, consumers, public surface, transitive impact, architecture, historical co-change, or a scip detector/gate.',
    '- Unsure how to explore, plan, verify, or clean up here: invoke the `scip-query` skill — it routes to the right specialist skill.',
    '- Each specialist skill carries its own command shortlist — prefer it over the full `_shared` catalog.',
    '- Before the first SCIP graph claim in a work session, run `scip-query status --capabilities` once. Reuse that fresh generation until source changes. After edits, let an active watcher finish its refresh; if it is busy or a refresh request is pending, wait and recheck instead of starting a competing reindex. Run `scip-query reindex` only when freshness is stale, missing, or unknown and the watcher is disabled, unavailable, or failed to refresh.',
    '- For a non-trivial change: establish the current entry-to-effect flow, the affected consumers, and the reuse options before editing (`scip-plan` skill, anchored by `scip-query plan-context <target>`).',
    '- Before claiming a complete relationship set, inspect the command coverage. If it is bounded or unknown, use `--full`, a narrower scope, or follow pagination emitted by the command before making the claim.',
    '- After the change, run the postchecks matching what you actually edited — the table is in the `scip-verify` skill — then `scip-query diff-gate`. Fix findings or state why each is accepted.',
    '- Prefer ordinary human output for agent reading: it preserves hierarchy, whitespace, and source line numbers without the JSON transport envelope. Use `--json` only for a programmatic consumer; add `--result-only` when that consumer needs only the command result. Do not use `--compact` for model-readable evidence.',
    '- Run scip-query commands normally, without choosing `--output-page-size` in advance. If and only if scip-query emits `Continue exactly:`, run each emitted command unchanged until the human footer reports transport completion or a JSON page reports `complete: true`; incomplete output is not evidence. Transport completion means every rendered character was retrieved, not that bounded command coverage became exhaustive. Never pipe scip-query through `head`, `tail`, or line-range `sed`. The emitted transport cursor is separate from a command result cursor such as `refs --cursor`.',
    '- Repository records: commit `.scipquery/goals/*.json`, `.scipquery/changes/*.json`, `.scipquery/attempts/*.json`, `.scipquery/decisions/*.json`, `.scipquery/obligations/*.json`, `.scipquery/obligation-transitions/*.json`, `.scipquery/completeness-admissions/*.json`, `.scipquery/transition-rules/*.json`, `.scipquery/completion-contexts/*.json`, `.scipquery/completion-evaluations/*.json`, `.scipquery/completion-transitions/*.json`, `.scipquery/suppressions/*.json`, and `.scipquery/events/*.json` with the work that produced them; do not ignore or drop these shared records.',
    '- Checkout preferences: `.codex/hooks.json` and `.claude/settings.local.json` are local agent-tool settings and must not be committed.',
    MD_BLOCK_END,
  ].join('\n');

  upsertManagedBlock(projectRoot, 'AGENTS.md', block, result);

  const shim = [MD_BLOCK_BEGIN, '@AGENTS.md', MD_BLOCK_END].join('\n');
  upsertManagedBlock(projectRoot, 'CLAUDE.md', shim, result, (current) => {
    // The user already bridges AGENTS.md into Claude Code themselves.
    return current.includes('@AGENTS.md') && !current.includes(MD_BLOCK_BEGIN);
  });
}

/** Create the file with the block, or replace/append only our marked block. */
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
      : {
          kind: 'write',
          text: next,
          ...(!snapshot.revision.exists ? { mode: 0o644 } : {}),
        };
  });
  if (!mutation) return;
  if (!mutation.changed || preserved) {
    result.unchanged.push(name);
  } else {
    result.written.push(name);
  }
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
      result.skipped.push({
        target: name,
        reason: error instanceof Error ? error.message : String(error),
      });
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
    result.skipped.push({
      target: label,
      reason: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/** Agent-agnostic backstop: gate the diff at commit time, whoever wrote it. */
function writeGitPreCommitHook(projectRoot: string, result: SetupAgentResult): void {
  const hooksDir = join(projectRoot, '.git', 'hooks');
  if (!existsSync(hooksDir)) {
    result.skipped.push({ target: '.git/hooks/pre-commit', reason: 'no .git/hooks directory (not a git repository?)' });
    return;
  }
  const path = join(hooksDir, 'pre-commit');
  const script = [
    '#!/bin/sh',
    PRE_COMMIT_MARKER,
    'scip-query diff-gate || {',
    '  echo "scip-query diff-gate failed — fix findings or commit with --no-verify to knowingly accept." >&2',
    '  exit 1',
    '}',
    '',
  ].join('\n');

  let foreign = false;
  const mutation = mutateManagedFile(path, '.git/hooks/pre-commit', result, (snapshot) => {
    if (snapshot.revision.exists && !snapshot.text.includes(PRE_COMMIT_MARKER)) {
      foreign = true;
      return { kind: 'unchanged' };
    }
    return snapshot.text === script ? { kind: 'unchanged' } : { kind: 'write', text: script, mode: 0o755 };
  });
  if (!mutation) return;
  if (foreign) {
    result.skipped.push({
      target: '.git/hooks/pre-commit',
      reason: 'a pre-commit hook already exists — add `scip-query diff-gate` to it manually',
    });
  } else if (mutation.changed) {
    result.written.push('.git/hooks/pre-commit');
  } else {
    result.unchanged.push('.git/hooks/pre-commit');
  }
}

function removeGitPreCommitHook(projectRoot: string, opts: { dryRun?: boolean }, result: RemoveAgentSetupResult): void {
  const path = join(projectRoot, '.git', 'hooks', 'pre-commit');
  if (opts.dryRun) {
    if (!existsSync(path)) result.unchanged.push('.git/hooks/pre-commit');
    else if (!readSmallArtifactText(path, 'pre-commit hook').includes(PRE_COMMIT_MARKER)) {
      result.skipped.push({
        target: '.git/hooks/pre-commit',
        reason: 'pre-commit hook is not managed by scip-query',
      });
    } else result.removed.push('.git/hooks/pre-commit');
    return;
  }
  let foreign = false;
  const mutation = mutateManagedFile(path, '.git/hooks/pre-commit', result, (snapshot) => {
    if (!snapshot.revision.exists) return { kind: 'unchanged' };
    if (!snapshot.text.includes(PRE_COMMIT_MARKER)) {
      foreign = true;
      return { kind: 'unchanged' };
    }
    return { kind: 'delete' };
  });
  if (!mutation) return;
  if (foreign) {
    result.skipped.push({
      target: '.git/hooks/pre-commit',
      reason: 'pre-commit hook is not managed by scip-query',
    });
  } else if (mutation.changed) {
    result.removed.push('.git/hooks/pre-commit');
  } else {
    result.unchanged.push('.git/hooks/pre-commit');
  }
}
