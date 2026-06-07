import type { ScipDatabase } from '../storage/db.js';
import type { CommandHandler } from './command-descriptor-types.js';
import { withDb } from './cli-context.js';
import { commandAnalysisBudget, renderHeuristicNotice } from './cli-support.js';
import { render } from './render.js';

export type CommandOptions = Record<string, unknown>;

export interface DbCommandContext {
  db: ScipDatabase;
  args: readonly unknown[];
  opts: CommandOptions;
}

export interface BudgetedCommandContext extends DbCommandContext {
  budget: ReturnType<typeof commandAnalysisBudget>;
}

export interface ListCommandSpec<Row> {
  query: (ctx: DbCommandContext) => readonly Row[];
  format: (row: Row, ctx: DbCommandContext) => string;
  emptyMessage?: (ctx: DbCommandContext) => string;
  heuristicLabel?: string;
  after?: (rows: readonly Row[], ctx: DbCommandContext) => void;
}

export interface TableCommandSpec<Row> {
  headers: readonly string[];
  query: (ctx: DbCommandContext) => readonly Row[];
  format: (row: Row, ctx: DbCommandContext) => string;
  emptyMessage?: (ctx: DbCommandContext) => string;
  heuristicLabel?: string;
  after?: (rows: readonly Row[], ctx: DbCommandContext) => void;
  dashWidths?: readonly number[];
}

export interface GroupedByFileCommandSpec<Row> {
  query: (ctx: DbCommandContext) => readonly Row[];
  format: (row: Row, ctx: DbCommandContext) => string;
  key?: (row: Row, ctx: DbCommandContext) => string;
  emptyMessage?: (ctx: DbCommandContext) => string;
  heuristicLabel?: string;
  after?: (rows: readonly Row[], ctx: DbCommandContext) => void;
}

export function dbCommand(run: (ctx: DbCommandContext) => void): CommandHandler {
  return (...rawArgs: unknown[]) => {
    const { args, opts } = splitCommanderActionArgs(rawArgs);
    withDb((db) => run({ db, args, opts }));
  };
}

export function budgetedDbCommand(
  commandName: string,
  run: (ctx: BudgetedCommandContext) => void,
): CommandHandler {
  return dbCommand((ctx) => {
    const budget = commandAnalysisBudget(ctx.db, commandName, booleanOptionValue(ctx.opts, 'full'));
    run({ ...ctx, budget });
  });
}

export function listCommand<Row>(spec: ListCommandSpec<Row>): CommandHandler {
  return dbCommand((ctx) => {
    const rows = spec.query(ctx);
    if (rows.length === 0 && spec.emptyMessage) {
      render.empty(spec.emptyMessage(ctx));
      return;
    }
    if (spec.heuristicLabel) renderHeuristicNotice(spec.heuristicLabel);
    render.list(rows, (row) => spec.format(row, ctx));
    spec.after?.(rows, ctx);
  });
}

export function tableCommand<Row>(spec: TableCommandSpec<Row>): CommandHandler {
  return dbCommand((ctx) => {
    const rows = spec.query(ctx);
    if (rows.length === 0 && spec.emptyMessage) {
      render.empty(spec.emptyMessage(ctx));
      return;
    }
    if (spec.heuristicLabel) renderHeuristicNotice(spec.heuristicLabel);
    render.table(spec.headers, rows.map((row) => spec.format(row, ctx)), spec.dashWidths);
    spec.after?.(rows, ctx);
  });
}

export function groupedByFileCommand<Row>(spec: GroupedByFileCommandSpec<Row>): CommandHandler {
  return dbCommand((ctx) => {
    const rows = spec.query(ctx);
    if (rows.length === 0 && spec.emptyMessage) {
      render.empty(spec.emptyMessage(ctx));
      return;
    }
    if (spec.heuristicLabel) renderHeuristicNotice(spec.heuristicLabel);
    render.groupedByFile(
      rows,
      (row) => spec.format(row, ctx),
      spec.key ? (row) => spec.key!(row, ctx) : undefined,
    );
    spec.after?.(rows, ctx);
  });
}

export function budgetedListCommand<Row>(
  commandName: string,
  spec: Omit<ListCommandSpec<Row>, 'query' | 'format'> & {
    query: (ctx: BudgetedCommandContext) => readonly Row[];
    format: (row: Row, ctx: BudgetedCommandContext) => string;
    after?: (rows: readonly Row[], ctx: BudgetedCommandContext) => void;
  },
): CommandHandler {
  return budgetedDbCommand(commandName, (ctx) => {
    const rows = spec.query(ctx);
    if (rows.length === 0 && spec.emptyMessage) {
      render.empty(spec.emptyMessage(ctx));
      return;
    }
    if (spec.heuristicLabel) renderHeuristicNotice(spec.heuristicLabel);
    render.list(rows, (row) => spec.format(row, ctx));
    spec.after?.(rows, ctx);
  });
}

export function budgetedTableCommand<Row>(
  commandName: string,
  spec: Omit<TableCommandSpec<Row>, 'query' | 'format'> & {
    query: (ctx: BudgetedCommandContext) => readonly Row[];
    format: (row: Row, ctx: BudgetedCommandContext) => string;
    after?: (rows: readonly Row[], ctx: BudgetedCommandContext) => void;
  },
): CommandHandler {
  return budgetedDbCommand(commandName, (ctx) => renderRows(ctx, spec, 'table'));
}

export function budgetedGroupedByFileCommand<Row>(
  commandName: string,
  spec: Omit<GroupedByFileCommandSpec<Row>, 'query' | 'format' | 'key'> & {
    query: (ctx: BudgetedCommandContext) => readonly Row[];
    format: (row: Row, ctx: BudgetedCommandContext) => string;
    key?: (row: Row, ctx: BudgetedCommandContext) => string;
    after?: (rows: readonly Row[], ctx: BudgetedCommandContext) => void;
  },
): CommandHandler {
  return budgetedDbCommand(commandName, (ctx) => renderRows(ctx, spec, 'grouped'));
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

export function booleanOptionValue(opts: CommandOptions, key: string): boolean {
  return Boolean(opts[key]);
}

export function definedNumberOption(opts: CommandOptions, key: string, fallback: number): number {
  return numberOptionValue(opts, key) ?? fallback;
}

function renderRows<Row>(
  ctx: BudgetedCommandContext,
  spec: (
    | (Omit<TableCommandSpec<Row>, 'query' | 'format'> & {
      query: (ctx: BudgetedCommandContext) => readonly Row[];
      format: (row: Row, ctx: BudgetedCommandContext) => string;
      after?: (rows: readonly Row[], ctx: BudgetedCommandContext) => void;
    })
    | (Omit<GroupedByFileCommandSpec<Row>, 'query' | 'format' | 'key'> & {
      query: (ctx: BudgetedCommandContext) => readonly Row[];
      format: (row: Row, ctx: BudgetedCommandContext) => string;
      key?: (row: Row, ctx: BudgetedCommandContext) => string;
      after?: (rows: readonly Row[], ctx: BudgetedCommandContext) => void;
    })
  ),
  shape: 'table' | 'grouped',
): void {
  const rows = spec.query(ctx);
  if (rows.length === 0 && spec.emptyMessage) {
    render.empty(spec.emptyMessage(ctx));
    return;
  }
  if (spec.heuristicLabel) renderHeuristicNotice(spec.heuristicLabel);
  if (shape === 'table') {
    const table = spec as TableCommandSpec<Row>;
    render.table(table.headers, rows.map((row) => table.format(row, ctx)), table.dashWidths);
  } else {
    const grouped = spec as GroupedByFileCommandSpec<Row>;
    render.groupedByFile(
      rows,
      (row) => grouped.format(row, ctx),
      grouped.key ? (row) => grouped.key!(row, ctx) : undefined,
    );
  }
  spec.after?.(rows, ctx);
}

function splitCommanderActionArgs(rawArgs: readonly unknown[]): { args: readonly unknown[]; opts: CommandOptions } {
  if (rawArgs.length === 0) return { args: [], opts: {} };
  const tail = rawArgs[rawArgs.length - 1];
  return {
    args: rawArgs.slice(0, -1),
    opts: commandOptions(tail),
  };
}

function commandOptions(value: unknown): CommandOptions {
  if (!value || typeof value !== 'object') return {};
  const maybeCommand = value as { opts?: () => unknown };
  if (typeof maybeCommand.opts === 'function') {
    const opts = maybeCommand.opts();
    return opts && typeof opts === 'object' ? opts as CommandOptions : {};
  }
  return value as CommandOptions;
}
