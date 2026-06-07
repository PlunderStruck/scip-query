import type { Command } from 'commander';

export type CommandOptionParser = (value: string, previous: unknown) => unknown;
export type CommandHandler = (...args: unknown[]) => void | Promise<void>;

export interface CommandArgumentDescriptor {
  name: string;
}

export interface CommandOptionDescriptor {
  flags: string;
  description: string;
  parser?: CommandOptionParser;
  defaultValue?: unknown;
}

export interface CommandDocumentation {
  category: string;
  examples?: readonly string[];
}

export interface CommandHeuristicNotice {
  label: string;
}

export type CommandBudgetPolicy = 'none' | 'semantic' | 'candidate-scan';
export type CommandRenderShape = 'custom' | 'empty' | 'list' | 'grouped-by-file' | 'sectioned-report' | 'table';

export interface CommandDescriptor {
  id: string;
  command: string;
  description: string;
  hidden?: boolean;
  arguments?: readonly CommandArgumentDescriptor[];
  options?: readonly CommandOptionDescriptor[];
  heuristic?: CommandHeuristicNotice;
  budget?: CommandBudgetPolicy;
  renderShape: CommandRenderShape;
  docs?: CommandDocumentation;
  handler: CommandHandler;
}

export interface RegisteredCommandDescriptor {
  descriptor: CommandDescriptor;
  command: Command;
}
