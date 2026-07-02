import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIFF_GATE_CHECKS, type DiffGateCheck } from '../src/queries/impact/diff-gate.js';
import { commandDescriptors } from '../src/runtime/commands/command-descriptors.js';
import { commandDocEntries, renderCommandReferenceMarkdown } from '../src/runtime/commands/command-docs.js';

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
  'doc-reference': {
    description:
      'Docs that cite changed files and may need a matching update. Dated snapshot docs (docs.snapshotPaths) are excluded by policy.',
    when: 'Default diff gate.',
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

if (process.argv.includes('--write')) {
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
} else {
  console.log(generated);
}

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
