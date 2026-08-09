import type { CommandDescriptor, CommandEvidenceTier, CommandSemanticContract } from './command-descriptor-types.js';
import type { CommandClaimContract } from '../claim-qualification.js';
import { commandOperationRoles } from '../command-operation.js';
import { GRAPH_RELATION_CONTRACTS } from '../../domain/graph-relation-contracts.js';
import { GRAPH_RELATION_PROVIDER_CONTRACTS } from '../../domain/graph-relation-providers.js';

export interface CommandDocEntry {
  id: string;
  command: string;
  description: string;
  category: string;
  options: readonly string[];
  hidden: boolean;
  heuristic: boolean;
  evidence: CommandEvidenceTier;
  claims: CommandClaimContract;
  semantic: CommandSemanticContract;
  deprecated: boolean;
}

export function commandDocEntries(descriptors: readonly CommandDescriptor[]): CommandDocEntry[] {
  return descriptors
    .filter((descriptor) => !descriptor.hidden)
    .map((descriptor) => ({
      id: descriptor.id,
      command: descriptor.command,
      description: descriptor.description,
      category: descriptor.docs?.category ?? 'Uncategorized',
      options: (descriptor.options ?? []).filter((option) => !option.hidden).map((option) => option.flags),
      hidden: Boolean(descriptor.hidden),
      heuristic: Boolean(descriptor.heuristic),
      evidence: descriptorEvidenceTier(descriptor),
      claims: descriptorClaimContract(descriptor),
      semantic: descriptorSemanticContract(descriptor),
      deprecated: descriptor.agent?.semantic?.compatibility === 'deprecated',
    }));
}

export function descriptorSemanticContract(descriptor: CommandDescriptor): CommandSemanticContract {
  if (!descriptor.agent) {
    throw new Error(`Public command ${descriptor.id} must declare an agent contract before semantic rendering.`);
  }
  if (descriptor.agent.semantic) return descriptor.agent.semantic;
  const roles = commandOperationRoles(descriptor.agent.operation);
  if (roles.some((role) => role !== 'repository-observation' && role !== 'repository-preview')) {
    return {
      kind: 'maintenance',
      effect: descriptor.agent.returns.join('; '),
      nonClaims: [
        'This command does not establish repository graph relationships unless its result says so explicitly.',
      ],
      outputCost: 'variable',
      frontierClosure: [],
    };
  }
  return {
    kind: 'analysis',
    analysis: descriptor.agent.answers.join(' '),
    resultMeaning: descriptor.agent.returns.join('; '),
    nonClaims: ['This command establishes only its declared result units and evidence contract.'],
    outputCost: descriptor.agent.coverage === 'complete' ? 'bounded' : 'variable',
    frontierClosure: ['inspect', 'code'],
  };
}

// scip-query: ignore-wrapper — shared evidence-tier policy consumed by both
// this renderer and command-registry.ts's setCommandEvidenceMap seed; one
// definition of "what tier is this command's evidence" for the whole CLI.
export function descriptorEvidenceTier(descriptor: CommandDescriptor): CommandEvidenceTier {
  if (descriptor.evidence) return descriptor.evidence;
  if (MIXED_EVIDENCE_COMMANDS.has(descriptor.id)) return 'mixed';
  return descriptor.heuristic ? 'heuristic' : 'graph-fact';
}

const MIXED_EVIDENCE_COMMANDS = new Set(['health', 'context', 'co-change']);

/**
 * Normalize descriptor declarations into the one registry contract consumed
 * by runtime output and generated documentation. Legacy evidence remains the
 * additive compatibility label; it is not reused as a claim qualification.
 */
export function descriptorClaimContract(descriptor: CommandDescriptor): CommandClaimContract {
  if (descriptor.claims) {
    if (descriptor.claims.origin === 'mixed' && !descriptor.claims.families?.length) {
      throw new Error(`Mixed command ${descriptor.id} must declare at least one claim family.`);
    }
    return descriptor.claims;
  }
  const evidence = descriptorEvidenceTier(descriptor);
  if (evidence === 'mixed') {
    throw new Error(`Mixed command ${descriptor.id} must declare claim families.`);
  }
  const roles = descriptor.agent ? commandOperationRoles(descriptor.agent.operation) : [];
  const repositoryEvidenceOnly =
    roles.length > 0 && roles.every((role) => role === 'repository-observation' || role === 'repository-preview');
  if (!repositoryEvidenceOnly) {
    return {
      origin: 'unknown',
      observedSources: ['process'],
      producerValidation: { status: 'not-evaluated' },
    };
  }
  return {
    origin: evidence === 'heuristic' ? 'heuristic' : 'compiler-graph',
    observedSources: ['index-generation'],
    producerValidation: { status: 'not-evaluated' },
  };
}

// scip-query: ignore-extract — the generated-reference renderer is one
// formatting pipeline; its sections have no other consumers.
export function renderCommandReferenceMarkdown(descriptors: readonly CommandDescriptor[]): string {
  const entries = commandDocEntries(descriptors);
  const categories = unique(entries.map((entry) => entry.category));
  const lines: string[] = [
    '<!-- BEGIN GENERATED COMMAND REFERENCE -->',
    '',
    'This syntax summary is generated from the CLI command descriptors. Keep workflow guidance hand-authored, but keep command syntax, descriptions, and option flags descriptor-owned.',
    '',
    'Commands with `--json` share three structured modes: plain `--json` emits the stable public envelope, `--json --result-only` emits only the command payload, and `--json --compact` minifies either form for a program. Agents should prefer ordinary human output. See [CLI output modes](CLI_JSON_OUTPUT.md).',
    '',
    'Every command accepts `--output-page-size <characters>` and `--output-cursor <cursor>`. Run normally without choosing a page size: oversized human output stays readable text and prints one exact continuation command; oversized JSON prints the exact command that opts into versioned JSON page envelopes.',
    'Cross-command evidence citations are off by default. With an explicit `SCIP_QUERY_SESSION`, a complete source unit, a byte-identical exact subset of a prior exact source read, or a graph unit/edge may be replaced by a visible receipt from the same index generation. Preview coverage never suppresses an exact unit; changed bytes, changed graph content, a new generation, or global `--reemit` force full evidence.',
    '',
  ];

  lines.push('### Agent operation catalogue', '');
  lines.push('| Operation | Commands |');
  lines.push('|---|---|');
  for (const [kind, label] of [
    ['locator', 'Locate exact roots'],
    ['graph-projection', 'Project typed relationships'],
    ['source-read', 'Read selected behavior/source'],
    ['analysis', 'Analyze declared result units'],
    ['maintenance', 'Maintain repository/tool state'],
  ] as const) {
    const commands = entries
      .filter((entry) => entry.semantic.kind === kind && !entry.deprecated)
      .map((entry) => `\`${escapeCode(entry.command)}\``);
    if (commands.length > 0) lines.push(`| ${label} | ${commands.join(', ')} |`);
  }
  lines.push('');
  lines.push('### Typed relationship meanings', '');
  lines.push('| Family | Establishes | Does not establish | Providers |');
  lines.push('|---|---|---|---|');
  for (const contract of GRAPH_RELATION_CONTRACTS) {
    lines.push(
      `| \`${contract.family}\` | ${escapeTableCell(contract.establishes)} | ${escapeTableCell(contract.nonClaims.join(' '))} | ${escapeTableCell(contract.providers.join(', '))} |`,
    );
  }
  lines.push('');
  lines.push('### Typed relationship providers', '');
  lines.push('| Provider | Family / subtype | Directions | Support ceiling | Establishes | Does not establish |');
  lines.push('|---|---|---|---|---|---|');
  for (const provider of GRAPH_RELATION_PROVIDER_CONTRACTS) {
    for (const relation of provider.relations) {
      const subtype = relation.match === 'prefix' ? `${relation.subtype}*` : relation.subtype;
      const cells = [
        `\`${provider.id}\``,
        `\`${relation.family}/${escapeCode(subtype)}\``,
        relation.directions.map((direction) => `\`${direction}\``).join(', '),
        `\`${relation.supportCeiling}\``,
        escapeTableCell(relation.establishes),
        escapeTableCell(relation.nonClaims.join(' ') || '-'),
      ];
      lines.push(`| ${cells.join(' | ')} |`);
    }
  }
  lines.push('');

  for (const category of categories) {
    const categoryEntries = entries.filter((entry) => entry.category === category);
    lines.push(`### ${escapeMarkdown(category)}`, '');
    lines.push('| Command | Description | Cost | Closes disclosed gaps with | Options |');
    lines.push('|---|---|---|---|---|');
    for (const entry of categoryEntries) {
      lines.push(
        `| \`${escapeCode(entry.command)}\` | ${escapeTableCell(entry.description)} | ${entry.semantic.outputCost} | ${entry.semantic.frontierClosure.length > 0 ? entry.semantic.frontierClosure.map((command) => `\`${escapeCode(command)}\``).join(', ') : '-'} | ${formatOptions(entry.options)} |`,
      );
    }
    lines.push('');
  }

  lines.push('<!-- END GENERATED COMMAND REFERENCE -->');
  return lines.join('\n');
}

function formatOptions(options: readonly string[]): string {
  return options.length > 0 ? options.map((option) => `\`${escapeCode(option)}\``).join('<br>') : '-';
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function escapeCode(value: string): string {
  return value.replaceAll('`', '\\`');
}

function escapeMarkdown(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('`', '\\`');
}

function escapeTableCell(value: string): string {
  return escapeMarkdown(value).replaceAll('|', '\\|');
}
