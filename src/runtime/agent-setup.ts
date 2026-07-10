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
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { blockingFindings } from '../queries/impact/diff-gate.js';
import type { DiffGateResult } from '../queries/impact/diff-gate.js';

const MD_BLOCK_BEGIN = '<!-- scip-query:agent-setup:begin -->';
const MD_BLOCK_END = '<!-- scip-query:agent-setup:end -->';
const PRE_COMMIT_MARKER = '# scip-query:agent-setup';

// ── Hook-side helpers (used by `diff-gate --hook`) ─────────────

/** Read piped stdin synchronously; '' when run interactively (TTY) or empty. */
export function readHookInput(): string {
  if (process.stdin.isTTY) return '';
  try {
    return readFileSync(0, 'utf-8');
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
    '- Unsure how to explore, plan, verify, or clean up here: invoke the `scip-query` skill — it routes to the right specialist skill.',
    '- Each specialist skill carries its own command shortlist — prefer it over the full `_shared` catalog.',
    '- For non-trivial implementation requests: plan first (`scip-concrete-plan` skill, anchored by `scip-query plan-context <target>`), then implement.',
    '- After the change, run the check matching what you did: extracted a helper -> `scip-query incomplete-migration`; new helper -> `scip-query recent-duplicates`; new params -> `scip-query unused-params`; new wrapper -> `scip-query wrapper-candidates`; schema/config change -> `scip-query co-change <file>`; deleted code -> `scip-query cleanup-plan --verify`.',
    '- Before declaring the work done: `scip-query reindex && scip-query diff-gate` — fix findings or state why each is accepted.',
    '- Repository records: commit `.scipquery/suppressions/*.json`, `.scipquery/ledger/events.jsonl`, and `.scipquery/ledger/.gitattributes` with the code or docs change that produced them; do not ignore or drop these shared records.',
    '- Checkout preferences: `.codex/hooks.json` and `.claude/settings.local.json` are local agent-tool settings and must not be committed.',
    MD_BLOCK_END,
  ].join('\n');

  upsertManagedBlock(projectRoot, 'AGENTS.md', block, result);

  const claudeCurrent = existsSync(join(projectRoot, 'CLAUDE.md'))
    ? readFileSync(join(projectRoot, 'CLAUDE.md'), 'utf-8')
    : '';
  if (claudeCurrent.includes('@AGENTS.md') && !claudeCurrent.includes(MD_BLOCK_BEGIN)) {
    // The user already bridges AGENTS.md into Claude Code themselves.
    result.unchanged.push('CLAUDE.md');
    return;
  }
  const shim = [MD_BLOCK_BEGIN, '@AGENTS.md', MD_BLOCK_END].join('\n');
  upsertManagedBlock(projectRoot, 'CLAUDE.md', shim, result);
}

/** Create the file with the block, or replace/append only our marked block. */
function upsertManagedBlock(projectRoot: string, name: string, block: string, result: SetupAgentResult): void {
  const path = join(projectRoot, name);
  const current = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  let next: string;
  if (current.includes(MD_BLOCK_BEGIN)) {
    const pattern = new RegExp(`${MD_BLOCK_BEGIN}[\\s\\S]*?${MD_BLOCK_END}`);
    next = current.replace(pattern, block);
  } else {
    next = current.length > 0 ? `${current.replace(/\n*$/, '\n\n')}${block}\n` : `${block}\n`;
  }
  if (next === current) {
    result.unchanged.push(name);
  } else {
    writeFileSync(path, next);
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
  if (!existsSync(path)) {
    result.unchanged.push(name);
    return;
  }
  const current = readFileSync(path, 'utf-8');
  if (!current.includes(MD_BLOCK_BEGIN)) {
    result.unchanged.push(name);
    return;
  }
  const pattern = new RegExp(`${MD_BLOCK_BEGIN}[\\s\\S]*?${MD_BLOCK_END}`);
  const next = current
    .replace(pattern, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  result.removed.push(name);
  if (opts.dryRun) return;
  if (next.length === 0) {
    rmSync(path, { force: true });
  } else {
    writeFileSync(path, `${next}\n`);
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

  if (existsSync(path)) {
    const current = readFileSync(path, 'utf-8');
    if (current.includes(PRE_COMMIT_MARKER)) {
      if (current === script) {
        result.unchanged.push('.git/hooks/pre-commit');
        return;
      }
    } else {
      result.skipped.push({
        target: '.git/hooks/pre-commit',
        reason: 'a pre-commit hook already exists — add `scip-query diff-gate` to it manually',
      });
      return;
    }
  }

  writeFileSync(path, script);
  chmodSync(path, 0o755);
  result.written.push('.git/hooks/pre-commit');
}

function removeGitPreCommitHook(projectRoot: string, opts: { dryRun?: boolean }, result: RemoveAgentSetupResult): void {
  const path = join(projectRoot, '.git', 'hooks', 'pre-commit');
  if (!existsSync(path)) {
    result.unchanged.push('.git/hooks/pre-commit');
    return;
  }
  const current = readFileSync(path, 'utf-8');
  if (!current.includes(PRE_COMMIT_MARKER)) {
    result.skipped.push({
      target: '.git/hooks/pre-commit',
      reason: 'pre-commit hook is not managed by scip-query',
    });
    return;
  }
  result.removed.push('.git/hooks/pre-commit');
  if (!opts.dryRun) rmSync(path, { force: true });
}
