import type { CommandDescriptor, InvocationCoverage } from './command-descriptor-types.js';
import type { ReportSection } from '../render.js';
import { withJsonOption as appendJsonOption } from './command-spec-builders.js';
import {
  budgetedSectionedReportCommand,
  groupedByFileCommand,
  listCommand,
  precomputedSectionedReportCommand,
  sectionedReportCommand,
  tableCommand,
  type CommandContext,
  type DbCommandContext,
  type PrecomputedCommandResult,
} from './command-execution.js';

type QueryCommandMetadata = Omit<CommandDescriptor, 'handler' | 'renderShape'>;

function withMetadataJsonOption(metadata: QueryCommandMetadata): QueryCommandMetadata {
  return { ...metadata, options: appendJsonOption(metadata.options) };
}

export function listQueryCommand<Row>({
  query,
  format,
  emptyMessage,
  heuristicLabel,
  before,
  toJson,
  coverage,
  agentResult,
  after,
  ...metadata
}: QueryCommandMetadata & Parameters<typeof listCommand<Row>>[0]): CommandDescriptor {
  const commandMetadata = withMetadataJsonOption(metadata);
  return {
    ...commandMetadata,
    renderShape: 'list',
    handler: listCommand({
      commandName: commandMetadata.id,
      query,
      format,
      emptyMessage,
      heuristicLabel,
      before,
      toJson,
      coverage,
      agentResult,
      after,
    }),
  };
}

export function tableQueryCommand<Row>({
  query,
  format,
  emptyMessage,
  heuristicLabel,
  before,
  toJson,
  coverage,
  agentResult,
  after,
  headers,
  dashWidths,
  ...metadata
}: QueryCommandMetadata & Parameters<typeof tableCommand<Row>>[0]): CommandDescriptor {
  const commandMetadata = withMetadataJsonOption(metadata);
  return {
    ...commandMetadata,
    renderShape: 'table',
    handler: tableCommand({
      commandName: commandMetadata.id,
      query,
      format,
      emptyMessage,
      heuristicLabel,
      before,
      toJson,
      coverage,
      agentResult,
      after,
      headers,
      dashWidths,
    }),
  };
}

export function groupedQueryCommand<Row>({
  query,
  format,
  emptyMessage,
  heuristicLabel,
  before,
  toJson,
  coverage,
  agentResult,
  after,
  key,
  ...metadata
}: QueryCommandMetadata & Parameters<typeof groupedByFileCommand<Row>>[0]): CommandDescriptor {
  const commandMetadata = withMetadataJsonOption(metadata);
  return {
    ...commandMetadata,
    renderShape: 'grouped-by-file',
    handler: groupedByFileCommand({
      commandName: commandMetadata.id,
      query,
      format,
      emptyMessage,
      heuristicLabel,
      before,
      toJson,
      coverage,
      agentResult,
      after,
      key,
    }),
  };
}

export function sectionedQueryCommand<Result>({
  query,
  emptyMessage,
  heuristicLabel,
  sections,
  before,
  toJson,
  coverage,
  agentResult,
  after,
  ...metadata
}: QueryCommandMetadata & Parameters<typeof sectionedReportCommand<Result>>[0]): CommandDescriptor {
  const commandMetadata = withMetadataJsonOption(metadata);
  return {
    ...commandMetadata,
    renderShape: 'sectioned-report',
    handler: sectionedReportCommand({
      commandName: commandMetadata.id,
      query,
      emptyMessage,
      heuristicLabel,
      before,
      sections,
      toJson,
      coverage,
      agentResult,
      after,
    }),
  };
}

export function precomputedSectionedQueryCommand<Result>({
  query,
  precomputed,
  emptyMessage,
  heuristicLabel,
  sections,
  before,
  toJson,
  coverage,
  agentResult,
  after,
  ...metadata
}: QueryCommandMetadata & {
  query: (ctx: DbCommandContext) => Result;
  precomputed: (ctx: CommandContext) => PrecomputedCommandResult<Result> | null;
  emptyMessage?: (result: Result, ctx: CommandContext) => string | undefined;
  heuristicLabel?: string;
  sections: (result: Result, ctx: CommandContext) => readonly ReportSection[];
  before?: (result: Result, ctx: CommandContext) => void;
  toJson?: (result: Result, ctx: CommandContext) => unknown;
  coverage?: (result: Result, ctx: CommandContext) => InvocationCoverage;
  agentResult?: (result: Result, ctx: CommandContext) => unknown;
  after?: (result: Result, ctx: CommandContext) => void;
}): CommandDescriptor {
  const commandMetadata = withMetadataJsonOption(metadata);
  const presentation = {
    commandName: commandMetadata.id,
    emptyMessage,
    heuristicLabel,
    sections,
    before,
    toJson,
    coverage,
    agentResult,
    after,
  };
  const fallback = sectionedReportCommand({ ...presentation, query });
  return {
    ...commandMetadata,
    renderShape: 'sectioned-report',
    handler: precomputedSectionedReportCommand(presentation, precomputed, fallback),
  };
}

export function budgetedSectionedQueryCommand<Result>({
  query,
  emptyMessage,
  heuristicLabel,
  sections,
  before,
  toJson,
  coverage,
  agentResult,
  after,
  ...metadata
}: QueryCommandMetadata & Parameters<typeof budgetedSectionedReportCommand<Result>>[1]): CommandDescriptor {
  const commandMetadata = withMetadataJsonOption(metadata);
  return {
    ...commandMetadata,
    budget: commandMetadata.budget ?? 'semantic',
    renderShape: 'sectioned-report',
    handler: budgetedSectionedReportCommand(commandMetadata.id, {
      commandName: commandMetadata.id,
      query,
      emptyMessage,
      heuristicLabel,
      before,
      sections,
      toJson,
      coverage,
      agentResult,
      after,
    }),
  };
}
