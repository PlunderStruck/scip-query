import type { CommandDescriptor } from './command-descriptor-types.js';
import { withJsonOption as appendJsonOption } from './command-spec-builders.js';
import {
  budgetedSectionedReportCommand,
  groupedByFileCommand,
  listCommand,
  sectionedReportCommand,
  tableCommand,
} from './command-execution.js';

type QueryCommandMetadata = Omit<CommandDescriptor, 'handler' | 'renderShape'>;

function withJsonOption(metadata: QueryCommandMetadata): QueryCommandMetadata {
  return { ...metadata, options: appendJsonOption(metadata.options) };
}

export function listQueryCommand<Row>({
  query,
  format,
  emptyMessage,
  heuristicLabel,
  after,
  ...metadata
}: QueryCommandMetadata & Parameters<typeof listCommand<Row>>[0]): CommandDescriptor {
  const commandMetadata = withJsonOption(metadata);
  return {
    ...commandMetadata,
    renderShape: 'list',
    handler: listCommand({ commandName: commandMetadata.id, query, format, emptyMessage, heuristicLabel, after }),
  };
}

export function tableQueryCommand<Row>({
  query,
  format,
  emptyMessage,
  heuristicLabel,
  after,
  headers,
  dashWidths,
  ...metadata
}: QueryCommandMetadata & Parameters<typeof tableCommand<Row>>[0]): CommandDescriptor {
  const commandMetadata = withJsonOption(metadata);
  return {
    ...commandMetadata,
    renderShape: 'table',
    handler: tableCommand({ commandName: commandMetadata.id, query, format, emptyMessage, heuristicLabel, after, headers, dashWidths }),
  };
}

export function groupedQueryCommand<Row>({
  query,
  format,
  emptyMessage,
  heuristicLabel,
  after,
  key,
  ...metadata
}: QueryCommandMetadata & Parameters<typeof groupedByFileCommand<Row>>[0]): CommandDescriptor {
  const commandMetadata = withJsonOption(metadata);
  return {
    ...commandMetadata,
    renderShape: 'grouped-by-file',
    handler: groupedByFileCommand({ commandName: commandMetadata.id, query, format, emptyMessage, heuristicLabel, after, key }),
  };
}

export function sectionedQueryCommand<Result>({
  query,
  emptyMessage,
  heuristicLabel,
  sections,
  before,
  after,
  ...metadata
}: QueryCommandMetadata & Parameters<typeof sectionedReportCommand<Result>>[0]): CommandDescriptor {
  const commandMetadata = withJsonOption(metadata);
  return {
    ...commandMetadata,
    renderShape: 'sectioned-report',
    handler: sectionedReportCommand({ commandName: commandMetadata.id, query, emptyMessage, heuristicLabel, before, sections, after }),
  };
}

export function budgetedSectionedQueryCommand<Result>({
  query,
  emptyMessage,
  heuristicLabel,
  sections,
  before,
  after,
  ...metadata
}: QueryCommandMetadata & Parameters<typeof budgetedSectionedReportCommand<Result>>[1]): CommandDescriptor {
  const commandMetadata = withJsonOption(metadata);
  return {
    ...commandMetadata,
    budget: commandMetadata.budget ?? 'semantic',
    renderShape: 'sectioned-report',
    handler: budgetedSectionedReportCommand(commandMetadata.id, { commandName: commandMetadata.id, query, emptyMessage, heuristicLabel, before, sections, after }),
  };
}
