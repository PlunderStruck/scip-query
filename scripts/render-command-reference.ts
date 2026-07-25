import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIFF_GATE_CHECKS, type DiffGateCheck } from '../src/queries/impact/diff-gate.js';
import { commandDescriptors } from '../src/runtime/commands/command-descriptors.js';
import { commandDocEntries, renderCommandReferenceMarkdown } from '../src/runtime/command-kit/command-docs.js';
import type { CommandDescriptor } from '../src/runtime/command-kit/command-descriptor-types.js';

const generated = renderCommandReferenceMarkdown(commandDescriptors);

const DIFF_GATE_CHECK_DESCRIPTIONS: Record<DiffGateCheck, { description: string; when: string }> = {
  echo: {
    description: 'Changed symbols that newly echo established code elsewhere.',
    when: 'Default diff gate.',
  },
  'incomplete-migration': {
    description: 'New helpers or abstractions wired into some sites while older inline sites remain.',
    when: 'Default diff gate.',
  },
  'co-change-partner': {
    description: 'Historically coupled files that usually change together but are missing from this diff.',
    when: 'Default diff gate.',
  },
  'twin-partner': {
    description:
      'A changed symbol has a same-(near-)name twin (identical or already-divergent) elsewhere that this diff left untouched.',
    when: 'Default diff gate. Advisory: findings print but never cause a nonzero exit by themselves.',
  },
  'coverage-contract': {
    description:
      'A configured `coverageContracts` entry (.scipquery.json) drifted: its declared key set no longer matches its ground-truth source.',
    when: 'Default diff gate, only when either side of a configured contract changed.',
  },
  architecture: {
    description: 'A declared architecture boundary rule has a violation absent from the committed health baseline.',
    when: 'Default diff gate when closed dependency rows, requireCompletePolicy, requireAcyclic, requireResolvedBoundaries, requireMinimalPolicy, maxBoundaryFanOut/maxBoundaryFiles, or testPaths are configured and a baseline exists.',
  },
  'doc-reference': {
    description:
      'Docs that cite changed files and may need a matching update. Dated snapshot docs (docs.snapshotPaths) are excluded by policy.',
    when: 'Default diff gate. Advisory (21.2) for bare file-mention citations; blocking when the citation has a line anchor or the cited file was deleted/renamed.',
  },
  'unused-params': {
    description: 'Fresh trailing parameters or options that no changed body uses.',
    when: 'Default diff gate.',
  },
  'new-dead': {
    description: 'Changed production symbols with zero indexed consumers.',
    when: 'Default diff gate.',
  },
  baseline: {
    description: 'New health finding identities compared with the committed health baseline.',
    when: 'Only with `diff-gate --baseline`.',
  },
};

function replaceGeneratedBlock(path: string, label: string, content: string): void {
  const current = readFileSync(path, 'utf8');
  const pattern = new RegExp(`<!-- BEGIN GENERATED ${label} -->[\\s\\S]*?<!-- END GENERATED ${label} -->`);
  if (!pattern.test(current)) return;
  writeFileSync(path, current.replace(pattern, content));
}

function renderDiffGateChecksMarkdown(): string {
  const rows = [
    '<!-- BEGIN GENERATED DIFF-GATE CHECKS -->',
    '| Check | What it catches | When it runs |',
    '| --- | --- | --- |',
    ...DIFF_GATE_CHECKS.map((check) => {
      const entry = DIFF_GATE_CHECK_DESCRIPTIONS[check];
      return `| \`${check}\` | ${entry.description} | ${entry.when} |`;
    }),
    '<!-- END GENERATED DIFF-GATE CHECKS -->',
  ];
  return rows.join('\n');
}

// ── Per-skill command allowlist (Plan 3, 19.1) ─────────────────────────────
//
// Each skill's SKILL.md frontmatter may declare a `commands:` list of exact
// invocation templates, e.g.:
//
//   commands:
//     - template: "scip-query twin-drift -s <scope> --json"
//       when: "Run the detector over the group's scope."
//
// This generator validates every template's base command and flags against
// `commandDescriptors` (unknown command/flag fails the build — the same
// guarantee the full catalog has) and renders a marker-delimited
// "## Commands for this skill" block into the skill body. Skills without a
// `commands:` key (e.g. `_shared`, the full-catalog reference) are skipped.

export interface SkillCommandEntry {
  template: string;
  when: string;
}

const SKILL_COMMANDS_BEGIN = '<!-- BEGIN GENERATED SKILL COMMANDS -->';
const SKILL_COMMANDS_END = '<!-- END GENERATED SKILL COMMANDS -->';

function writeSkillCommandBlocks(skillsRoot: string): void {
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillMdPath = join(skillsRoot, entry.name, 'SKILL.md');
    try {
      if (!statSync(skillMdPath).isFile()) continue;
    } catch {
      continue;
    }
    const raw = readFileSync(skillMdPath, 'utf8');
    const commands = parseSkillCommands(raw, `skills/${entry.name}/SKILL.md`);
    if (commands.length === 0) continue;
    for (const command of commands) validateSkillCommand(command, `skills/${entry.name}/SKILL.md`);
    const block = renderSkillCommandsMarkdown(commands);
    const updated = spliceGeneratedBlock(raw, SKILL_COMMANDS_BEGIN, SKILL_COMMANDS_END, block);
    if (updated !== raw) writeFileSync(skillMdPath, updated);
  }
}

export function parseSkillCommands(raw: string, sourceLabel: string): SkillCommandEntry[] {
  const frontmatterMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return [];
  const frontmatter = frontmatterMatch[1] ?? '';
  const lines = frontmatter.split('\n');
  const startIndex = lines.findIndex((line) => /^commands:\s*$/.test(line));
  if (startIndex === -1) return [];

  const entries: SkillCommandEntry[] = [];
  let current: Partial<SkillCommandEntry> | null = null;
  for (const line of lines.slice(startIndex + 1)) {
    if (/^\S/.test(line)) break; // dedent — next top-level frontmatter key
    // Quote style is not ours to control here: `npm run format` (prettier's
    // YAML formatter) rewrites frontmatter string quoting per-line — single
    // quotes by default, double only when the value itself contains an
    // apostrophe (e.g. "the model's Next relation"). Both quote styles must
    // parse, or a plain `prettier --write` silently empties a skill's
    // commands list (this broke scip-tla-model-system's router preview row).
    const templateMatch = line.match(/^\s*-\s*template:\s*(?:"(.*)"|'(.*)')\s*$/);
    const whenMatch = line.match(/^\s*when:\s*(?:"(.*)"|'(.*)')\s*$/);
    if (templateMatch) {
      if (current?.template) entries.push(finishSkillCommandEntry(current, sourceLabel));
      current = { template: templateMatch[1] ?? templateMatch[2] };
    } else if (whenMatch && current) {
      current.when = whenMatch[1] ?? whenMatch[2];
    }
  }
  if (current?.template) entries.push(finishSkillCommandEntry(current, sourceLabel));
  return entries;
}

function finishSkillCommandEntry(entry: Partial<SkillCommandEntry>, sourceLabel: string): SkillCommandEntry {
  if (!entry.template) throw new Error(`${sourceLabel}: commands entry missing template`);
  if (!entry.when) throw new Error(`${sourceLabel}: commands entry "${entry.template}" missing when`);
  return { template: entry.template, when: entry.when };
}

function skillCommandTokens(template: string): string[] {
  const withoutPrefix = template.replace(/^scip-query\s+/, '');
  return withoutPrefix.split(/\s+/).filter(Boolean);
}

function findDescriptorForCommandId(commandId: string): CommandDescriptor | undefined {
  return commandDescriptors.find((descriptor) => descriptor.command.split(/\s+/)[0] === commandId);
}

export function validateSkillCommand(entry: SkillCommandEntry, sourceLabel: string): void {
  const tokens = skillCommandTokens(entry.template);
  const commandId = tokens[0];
  const descriptor = commandId ? findDescriptorForCommandId(commandId) : undefined;
  if (!descriptor) {
    throw new Error(`${sourceLabel}: unknown command "${commandId ?? entry.template}" in commands frontmatter`);
  }
  const knownFlags = new Set<string>();
  for (const opt of descriptor.options ?? []) {
    for (const part of opt.flags.split(',')) {
      const flag = part.trim().split(/\s+/)[0];
      if (flag) knownFlags.add(flag);
    }
  }
  for (const token of tokens.slice(1)) {
    if (!token.startsWith('-')) continue;
    if (!knownFlags.has(token)) {
      throw new Error(
        `${sourceLabel}: unknown flag "${token}" for command "${commandId}" (template: ${entry.template})`,
      );
    }
  }
}

function escapeSkillTableCell(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('|', '\\|');
}

export function renderSkillCommandsMarkdown(commands: readonly SkillCommandEntry[]): string {
  const rows = [
    SKILL_COMMANDS_BEGIN,
    '## Commands for this skill',
    '',
    '| Command | Purpose | Returns | Coverage | When |',
    '| --- | --- | --- | --- | --- |',
    ...commands.map((entry) => {
      const commandId = skillCommandTokens(entry.template)[0] ?? '';
      const descriptor = findDescriptorForCommandId(commandId);
      const purpose = descriptor?.description ?? '';
      const returns = descriptor?.agent?.returns.join('; ') ?? 'Undeclared';
      const coverage = descriptor?.agent?.coverage ?? 'unknown';
      return `| \`${entry.template}\` | ${escapeSkillTableCell(purpose)} | ${escapeSkillTableCell(returns)} | \`${coverage}\` | ${escapeSkillTableCell(entry.when)} |`;
    }),
    '',
    'Use this shortlist first. Open [`../_shared/SKILL.md`](../_shared/SKILL.md) only when it is insufficient.',
    SKILL_COMMANDS_END,
  ];
  return rows.join('\n');
}

function spliceGeneratedBlock(raw: string, beginMarker: string, endMarker: string, block: string): string {
  const pattern = new RegExp(
    `${beginMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${endMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
  );
  if (pattern.test(raw)) return raw.replace(pattern, block);

  const lines = raw.split('\n');
  const sharedLineIndex = lines.findIndex((line) => line.includes('Load shared mechanics'));
  const headingIndex = lines.findIndex((line) => line.startsWith('# '));
  const insertAt = sharedLineIndex !== -1 ? sharedLineIndex + 1 : headingIndex !== -1 ? headingIndex + 1 : lines.length;
  lines.splice(insertAt, 0, '', block);
  return lines.join('\n');
}

// ── Router 3-command preview (19.1d / 19.5) ────────────────────────────────
//
// Below the router's Routes table, render a compact per-skill "top 3
// commands" preview sourced from each routed skill's own `commands:`
// frontmatter, so routing can happen without loading the target skill.

const ROUTER_PREVIEW_BEGIN = '<!-- BEGIN GENERATED ROUTER COMMAND PREVIEW -->';
const ROUTER_PREVIEW_END = '<!-- END GENERATED ROUTER COMMAND PREVIEW -->';

function writeRouterCommandPreview(routerSkillMdPath: string): void {
  const raw = readFileSync(routerSkillMdPath, 'utf8');
  const skillNames = [...raw.matchAll(/\|\s*`([a-z][a-z0-9-]*)`\s*\|/g)].map((match) => match[1]);
  const uniqueSkillNames = [...new Set(skillNames)].sort();
  const skillsRoot = join(process.cwd(), 'skills');
  const rows = [
    ROUTER_PREVIEW_BEGIN,
    '## Command Preview',
    '',
    "Top commands per routed skill, generated from each skill's own `commands:` frontmatter.",
    '',
    '| Skill | Top commands |',
    '| --- | --- |',
  ];
  for (const skillName of uniqueSkillNames) {
    const skillMdPath = join(skillsRoot, skillName, 'SKILL.md');
    let commands: SkillCommandEntry[];
    try {
      commands = parseSkillCommands(readFileSync(skillMdPath, 'utf8'), `skills/${skillName}/SKILL.md`);
    } catch {
      continue;
    }
    if (commands.length === 0) continue;
    const preview = commands
      .slice(0, 3)
      .map((entry) => `\`${entry.template}\``)
      .join(', ');
    rows.push(`| \`${skillName}\` | ${preview} |`);
  }
  rows.push(ROUTER_PREVIEW_END);
  const block = rows.join('\n');
  const pattern = new RegExp(`${ROUTER_PREVIEW_BEGIN}[\\s\\S]*?${ROUTER_PREVIEW_END}`);
  const updated = pattern.test(raw) ? raw.replace(pattern, block) : `${raw.replace(/\n+$/, '')}\n\n${block}\n`;
  if (updated !== raw) writeFileSync(routerSkillMdPath, updated);
}

function renderSkillCommandFamiliesMarkdown(): string {
  const entries = commandDocEntries(commandDescriptors);
  const categories = [...new Set(entries.map((entry) => entry.category))];
  const rows = [
    '<!-- BEGIN GENERATED COMMAND FAMILIES -->',
    '',
    'This syntax catalog is generated from the CLI command descriptors.',
    '',
  ];

  for (const category of categories) {
    const categoryEntries = entries.filter((entry) => entry.category === category);
    rows.push(`### ${category}`, '', '```bash');
    for (const entry of categoryEntries) {
      rows.push(`scip-query ${entry.command} # ${entry.description}`);
    }
    rows.push('```', '');
  }

  rows.push('<!-- END GENERATED COMMAND FAMILIES -->');
  return rows.join('\n');
}

// Skip all top-level side effects when this module is imported by the test
// runner (Vitest sets VITEST=true) — a unit test importing the pure
// parse/validate/render functions below must not print or write anything.
const isTestImport = process.env['VITEST'] === 'true';

if (!isTestImport && process.argv.includes('--write')) {
  const generatedDiffGateChecks = renderDiffGateChecksMarkdown();
  const generatedSkillCommandFamilies = renderSkillCommandFamiliesMarkdown();
  replaceGeneratedBlock(join(process.cwd(), 'docs/COMMAND_REFERENCE.md'), 'COMMAND REFERENCE', generated);
  for (const relativePath of ['README.md', 'docs/AI_FAILURE_MODES.md', 'docs/DETECTOR_GUIDE.md']) {
    replaceGeneratedBlock(join(process.cwd(), relativePath), 'DIFF-GATE CHECKS', generatedDiffGateChecks);
  }
  replaceGeneratedBlock(
    join(process.cwd(), 'skills/_shared/SKILL.md'),
    'COMMAND FAMILIES',
    generatedSkillCommandFamilies,
  );
  writeSkillCommandBlocks(join(process.cwd(), 'skills'));
  writeRouterCommandPreview(join(process.cwd(), 'skills/scip-query/SKILL.md'));
} else if (!isTestImport) {
  console.log(generated);
}
