import { GRAPH_RELATION_QUESTIONS, graphRelationContract } from '../../domain/graph-relation-contracts.js';
import type {
  GraphRelationEvidenceStrength,
  GraphRelationSupportCeiling,
} from '../../domain/graph-relation-providers.js';
import { GRAPH_EVIDENCE_STRENGTH_DEFINITIONS } from '../../domain/graph-relation-providers.js';
import type { GraphEvidenceFamily, GraphProjectionDirection } from '../../domain/graph-exploration-contract.js';
import type { CommandDescriptor, CommandOutputCost } from './command-descriptor-types.js';

export const PRIMARY_EXPLORATION_COMMAND_IDS = [
  'search',
  'outline',
  'entrypoints',
  'evidence',
  'inspect',
  'code',
] as const;

export type PrimaryExplorationCommandId = (typeof PRIMARY_EXPLORATION_COMMAND_IDS)[number];

export interface ExplorationControlManualRow {
  stage: 'locate' | 'project' | 'read';
  id: PrimaryExplorationCommandId;
  command: string;
  question: string;
  requiredInput: string;
  returnedFact: string;
  evidenceCeiling: string;
  nonClaim: string;
  outputCost: CommandOutputCost;
  contrasts: readonly string[];
  gapClosingCommands: readonly string[];
}

export interface ExplorationRelationshipManualRow {
  question: string;
  family: GraphEvidenceFamily;
  direction: GraphProjectionDirection;
  establishes: string;
  evidenceStrengths: readonly GraphRelationEvidenceStrength[];
  supportCeilings: readonly GraphRelationSupportCeiling[];
  nonClaim: string;
}

const STAGES: Readonly<Record<PrimaryExplorationCommandId, ExplorationControlManualRow['stage']>> = {
  search: 'locate',
  outline: 'locate',
  entrypoints: 'locate',
  evidence: 'project',
  inspect: 'read',
  code: 'read',
};

export function explorationControlManualRows(
  descriptors: readonly CommandDescriptor[],
): readonly ExplorationControlManualRow[] {
  return PRIMARY_EXPLORATION_COMMAND_IDS.map((id) => {
    const descriptor = descriptors.find((candidate) => candidate.id === id);
    if (!descriptor?.agent?.semantic)
      throw new Error(`Primary exploration command ${id} must declare semantic metadata.`);
    if (descriptor.hidden || descriptor.agent.semantic.compatibility === 'deprecated') {
      throw new Error(`Primary exploration command ${id} cannot be hidden or deprecated.`);
    }
    const semantic = descriptor.agent.semantic;
    if (!semantic.manualInput) throw new Error(`Primary exploration command ${id} must declare manualInput.`);
    if (!semantic.evidenceCeiling) throw new Error(`Primary exploration command ${id} must declare evidenceCeiling.`);
    return {
      stage: STAGES[id],
      id,
      command: descriptor.command,
      question: descriptor.agent.answers.join(' '),
      requiredInput: semantic.manualInput,
      returnedFact: descriptor.agent.returns.join('; '),
      evidenceCeiling: semantic.evidenceCeiling,
      nonClaim: semantic.nonClaims.join(' '),
      outputCost: semantic.outputCost,
      contrasts: (descriptor.agent.contrasts ?? []).map((contrast) => `${contrast.command}: ${contrast.distinction}`),
      gapClosingCommands: semantic.frontierClosure,
    };
  });
}

export function explorationRelationshipManualRows(): readonly ExplorationRelationshipManualRow[] {
  return GRAPH_RELATION_QUESTIONS.map((question) => {
    const contract = graphRelationContract(question.family);
    return {
      ...question,
      establishes: contract.establishes,
      evidenceStrengths: unique(contract.relations.flatMap((relation) => relation.evidenceStrengths)),
      supportCeilings: unique(contract.relations.map((relation) => relation.supportCeiling)),
      nonClaim: contract.nonClaims.join(' '),
    };
  });
}

export function renderExplorationManualMarkdown(descriptors: readonly CommandDescriptor[]): string {
  const lines = [
    '### Exploration control manual',
    '',
    'The operator chooses the material question and deliberately selects a control. These contracts describe observations; they do not infer task relevance.',
    '',
    '| Stage | Control | Question answered | Required input | Returned fact | Evidence ceiling | Does not establish | Cost | Contrast | Close a gap with |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const row of explorationControlManualRows(descriptors)) {
    lines.push(
      `| ${row.stage} | \`${escapeCode(row.command)}\` | ${escapeCell(row.question)} | ${escapeCell(row.requiredInput)} | ${escapeCell(row.returnedFact)} | ${escapeCell(row.evidenceCeiling)} | ${escapeCell(row.nonClaim)} | \`${row.outputCost}\` | ${escapeCell(row.contrasts.join(' ')) || '-'} | ${formatCommands(row.gapClosingCommands)} |`,
    );
  }
  lines.push('', '### Relationship question manual', '');
  lines.push(
    '| Material question | Family | Direction | Establishes | Reported strengths | Provider ceilings | Does not establish |',
  );
  lines.push('|---|---|---|---|---|---|---|');
  for (const row of explorationRelationshipManualRows()) {
    lines.push(
      `| ${escapeCell(row.question)} | \`${row.family}\` | \`${row.direction}\` | ${escapeCell(row.establishes)} | ${row.evidenceStrengths.map((strength) => `\`${strength}\``).join(', ')} | ${row.supportCeilings.map((ceiling) => `\`${ceiling}\``).join(', ')} | ${escapeCell(row.nonClaim)} |`,
    );
  }
  lines.push('', '### Evidence strength legend', '', '| Strength | Meaning |', '|---|---|');
  for (const [strength, meaning] of Object.entries(GRAPH_EVIDENCE_STRENGTH_DEFINITIONS)) {
    lines.push(`| \`${strength}\` | ${escapeCell(meaning)} |`);
  }
  return lines.join('\n');
}

export function renderExplorationManualAgentLines(descriptors: readonly CommandDescriptor[]): readonly string[] {
  const controls = explorationControlManualRows(descriptors).map(
    (row) =>
      `- ${capitalize(row.stage)} control \`scip-query ${row.command}\`: ${row.question} Input: ${row.requiredInput} Returns: ${row.returnedFact} Ceiling: ${row.evidenceCeiling} Does not establish: ${row.nonClaim} Cost: ${row.outputCost}. Contrast: ${row.contrasts.join(' ') || 'none'}. Close disclosed gaps with: ${row.gapClosingCommands.join(', ') || 'none'}.`,
  );
  const relationships = explorationRelationshipManualRows()
    .map((row) => `\`${row.family} ${row.direction}\` — ${row.question}`)
    .join('; ');
  const strengths = Object.entries(GRAPH_EVIDENCE_STRENGTH_DEFINITIONS)
    .map(([strength, meaning]) => `\`${strength}\`: ${meaning}`)
    .join(' ');
  return [
    ...controls,
    `- Relationship controls: ${relationships}. Choose these explicitly; the CLI does not infer them from English intent.`,
    `- Evidence strengths: ${strengths}`,
  ];
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function formatCommands(commands: readonly string[]): string {
  return commands.length > 0 ? commands.map((command) => `\`${escapeCode(command)}\``).join(', ') : '-';
}

function escapeCode(value: string): string {
  return value.replaceAll('`', '\\`');
}

function escapeCell(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('|', '\\|');
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
