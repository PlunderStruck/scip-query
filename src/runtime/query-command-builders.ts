import type { CommandDescriptor } from './command-descriptor-types.js';
import {
  budgetedSectionedReportCommand,
  groupedByFileCommand,
  listCommand,
  sectionedReportCommand,
  tableCommand,
} from './command-execution.js';

type QueryCommandMetadata = Omit<CommandDescriptor, 'handler' | 'renderShape'>;

export function listQueryCommand<Row>({
  query,
  format,
  emptyMessage,
  heuristicLabel,
  after,
  ...metadata
}: QueryCommandMetadata & Parameters<typeof listCommand<Row>>[0]): CommandDescriptor {
  return {
    ...metadata,
    renderShape: 'list',
    handler: listCommand({ query, format, emptyMessage, heuristicLabel, after }),
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
  return {
    ...metadata,
    renderShape: 'table',
    handler: tableCommand({ query, format, emptyMessage, heuristicLabel, after, headers, dashWidths }),
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
  return {
    ...metadata,
    renderShape: 'grouped-by-file',
    handler: groupedByFileCommand({ query, format, emptyMessage, heuristicLabel, after, key }),
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
  return {
    ...metadata,
    renderShape: 'sectioned-report',
    handler: sectionedReportCommand({ query, emptyMessage, heuristicLabel, before, sections, after }),
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
  return {
    ...metadata,
    budget: metadata.budget ?? 'semantic',
    renderShape: 'sectioned-report',
    handler: budgetedSectionedReportCommand(metadata.id, { query, emptyMessage, heuristicLabel, before, sections, after }),
  };
}
