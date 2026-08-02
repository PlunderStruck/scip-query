import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readSmallArtifactText } from '../platform/bounded-file.js';
import {
  mutateTextFileRevisionAware,
  type RevisionedTextMutation,
  type RevisionedTextSnapshot,
} from './revisioned-file.js';

const MD_BLOCK_BEGIN = '<!-- scip-query:agent-setup:begin -->';
const MD_BLOCK_END = '<!-- scip-query:agent-setup:end -->';
const LEGACY_PRE_COMMIT_MARKER = '# scip-query:agent-setup';

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

export function setupAgent(projectRoot: string): SetupAgentResult {
  const result: SetupAgentResult = { written: [], unchanged: [], skipped: [] };
  writeInstructionsBlock(projectRoot, result);
  return result;
}

export function removeAgentSetup(projectRoot: string, opts: { dryRun?: boolean } = {}): RemoveAgentSetupResult {
  const result: RemoveAgentSetupResult = { removed: [], unchanged: [], skipped: [] };
  removeManagedBlock(projectRoot, 'AGENTS.md', opts, result);
  removeManagedBlock(projectRoot, 'CLAUDE.md', opts, result);
  removeLegacyPreCommitHook(projectRoot, opts, result);
  return result;
}

function writeInstructionsBlock(projectRoot: string, result: SetupAgentResult): void {
  const block = [
    MD_BLOCK_BEGIN,
    '## scip-query',
    '',
    'This repository uses scip-query for compiler-backed code intelligence.',
    '',
    '- Use native search and file reads for literal text and source.',
    '- Use `scip-query context <target>` to map flow, consumers, reuse options, constraints, and relevant source before a nonlocal change.',
    '- Use focused graph commands when a compiler-resolved relationship can change the plan. Do not rerun an unchanged read-only query.',
    '- Use `scip-query diff-impact` to map changed symbols and downstream consumers after a nontrivial edit.',
    '- Use `scip-query architecture` to inspect explicit structural rules.',
    '- Use `scip-query health` to find React, Vue, duplication, complexity, drift, and cleanup candidates.',
    '- Treat compiler-graph findings as facts within stated coverage. Treat heuristic findings as candidates that need source confirmation.',
    '- Before claiming a complete relationship set, inspect coverage and use `--full` only when complete coverage can change the decision.',
    '- Prefer human output for agent reading. Use `--json --result-only` only for a programmatic consumer.',
    '- If output emits `Continue exactly:`, run that command unchanged until transport is complete.',
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
