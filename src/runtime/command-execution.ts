import type { ScipDatabase } from '../storage/db.js';
import type { CommandHandler } from './command-descriptor-types.js';
import { withDb } from './cli-context.js';
import { render } from './render.js';

export type CommandOptions = Record<string, unknown>;

export interface DbCommandContext {
  db: ScipDatabase;
  args: readonly unknown[];
  opts: CommandOptions;
}

export interface ListCommandSpec<Row> {
  query: (ctx: DbCommandContext) => readonly Row[];
  format: (row: Row, ctx: DbCommandContext) => string;
  emptyMessage?: (ctx: DbCommandContext) => string;
  after?: (rows: readonly Row[], ctx: DbCommandContext) => void;
}

export interface TableCommandSpec<Row> {
  headers: readonly string[];
  query: (ctx: DbCommandContext) => readonly Row[];
  format: (row: Row, ctx: DbCommandContext) => string;
  dashWidths?: readonly number[];
}

export function dbCommand(run: (ctx: DbCommandContext) => void): CommandHandler {
  return (...rawArgs: unknown[]) => {
    const { args, opts } = splitCommanderActionArgs(rawArgs);
    withDb((db) => run({ db, args, opts }));
  };
}

export function listCommand<Row>(spec: ListCommandSpec<Row>): CommandHandler {
  return dbCommand((ctx) => {
    const rows = spec.query(ctx);
    if (rows.length === 0 && spec.emptyMessage) {
      render.empty(spec.emptyMessage(ctx));
      return;
    }
    render.list(rows, (row) => spec.format(row, ctx));
    spec.after?.(rows, ctx);
  });
}

export function tableCommand<Row>(spec: TableCommandSpec<Row>): CommandHandler {
  return dbCommand((ctx) => {
    const rows = spec.query(ctx);
    render.table(spec.headers, rows.map((row) => spec.format(row, ctx)), spec.dashWidths);
  });
}

export function stringArg(args: readonly unknown[], index: number): string {
  return String(args[index]);
}

export function optionalStringArg(args: readonly unknown[], index: number): string | undefined {
  const value = args[index];
  return typeof value === 'string' ? value : undefined;
}

export function stringOptionValue(opts: CommandOptions, key: string): string | undefined {
  const value = opts[key];
  return typeof value === 'string' ? value : undefined;
}

export function numberOptionValue(opts: CommandOptions, key: string): number | undefined {
  const value = opts[key];
  return typeof value === 'number' ? value : undefined;
}

export function definedNumberOption(opts: CommandOptions, key: string, fallback: number): number {
  return numberOptionValue(opts, key) ?? fallback;
}

function splitCommanderActionArgs(rawArgs: readonly unknown[]): { args: readonly unknown[]; opts: CommandOptions } {
  if (rawArgs.length === 0) return { args: [], opts: {} };
  const tail = rawArgs[rawArgs.length - 1];
  return {
    args: rawArgs.slice(0, -1),
    opts: tail && typeof tail === 'object' ? tail as CommandOptions : {},
  };
}
