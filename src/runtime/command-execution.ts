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

interface RowCommandSpec<Row, Ctx extends DbCommandContext> {
  query: (ctx: Ctx) => readonly Row[];
  format: (row: Row, ctx: Ctx) => string;
  emptyMessage?: (ctx: Ctx) => string;
  heuristicLabel?: string;
  after?: (rows: readonly Row[], ctx: Ctx) => void;
}

type RowRenderer<Row, Ctx extends DbCommandContext> =
  | { kind: 'list' }
  | { kind: 'table'; headers: readonly string[]; dashWidths?: readonly number[] }
  | { kind: 'grouped'; key?: (row: Row, ctx: Ctx) => string };

export interface ListCommandSpec<Row> extends RowCommandSpec<Row, DbCommandContext> {
}

export interface TableCommandSpec<Row> extends RowCommandSpec<Row, DbCommandContext> {
  headers: readonly string[];
  dashWidths?: readonly number[];
}

export interface GroupedByFileCommandSpec<Row> extends RowCommandSpec<Row, DbCommandContext> {
  key?: (row: Row, ctx: DbCommandContext) => string;
}

export interface ReportCommandSpec<Result, Ctx extends DbCommandContext = DbCommandContext> {
  query: (ctx: Ctx) => Result;
  emptyMessage?: (result: Result, ctx: Ctx) => string | undefined;
  heuristicLabel?: string;
  render: (result: Result, ctx: Ctx) => void;
  after?: (result: Result, ctx: Ctx) => void;
}

interface CommandOutputSpec<Output, Ctx extends DbCommandContext> {
  query: (ctx: Ctx) => Output;
  emptyMessage?: (output: Output, ctx: Ctx) => string | undefined;
  heuristicLabel?: string;
  render: (output: Output, ctx: Ctx) => void;
  after?: (output: Output, ctx: Ctx) => void;
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
  return dbCommand((ctx) => renderRows(ctx, spec, { kind: 'list' }));
}

export function tableCommand<Row>(spec: TableCommandSpec<Row>): CommandHandler {
  return dbCommand((ctx) =>
    renderRows(ctx, spec, { kind: 'table', headers: spec.headers, dashWidths: spec.dashWidths }));
}

export function groupedByFileCommand<Row>(spec: GroupedByFileCommandSpec<Row>): CommandHandler {
  return dbCommand((ctx) =>
    renderRows(ctx, spec, { kind: 'grouped', key: spec.key }));
}

export function reportCommand<Result>(spec: ReportCommandSpec<Result>): CommandHandler {
  return dbCommand((ctx) => runCommandOutput(ctx, spec));
}

export function budgetedReportCommand<Result>(
  commandName: string,
  spec: ReportCommandSpec<Result, BudgetedCommandContext>,
): CommandHandler {
  return budgetedDbCommand(commandName, (ctx) => runCommandOutput(ctx, spec));
}

export function budgetedListCommand<Row>(
  commandName: string,
  spec: RowCommandSpec<Row, BudgetedCommandContext>,
): CommandHandler {
  return budgetedDbCommand(commandName, (ctx) => renderRows(ctx, spec, { kind: 'list' }));
}

export function budgetedTableCommand<Row>(
  commandName: string,
  spec: RowCommandSpec<Row, BudgetedCommandContext> & {
    headers: readonly string[];
    dashWidths?: readonly number[];
  },
): CommandHandler {
  return budgetedDbCommand(commandName, (ctx) =>
    renderRows(ctx, spec, { kind: 'table', headers: spec.headers, dashWidths: spec.dashWidths }));
}

export function budgetedGroupedByFileCommand<Row>(
  commandName: string,
  spec: RowCommandSpec<Row, BudgetedCommandContext> & {
    key?: (row: Row, ctx: BudgetedCommandContext) => string;
  },
): CommandHandler {
  return budgetedDbCommand(commandName, (ctx) =>
    renderRows(ctx, spec, { kind: 'grouped', key: spec.key }));
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

function renderRows<Row, Ctx extends DbCommandContext>(
  ctx: Ctx,
  spec: RowCommandSpec<Row, Ctx>,
  renderer: RowRenderer<Row, Ctx>,
): void {
  runCommandOutput(ctx, {
    query: spec.query,
    emptyMessage: (rows, rowCtx) => rows.length === 0 && spec.emptyMessage
      ? spec.emptyMessage(rowCtx)
      : undefined,
    heuristicLabel: spec.heuristicLabel,
    render: (rows, rowCtx) => {
      if (renderer.kind === 'list') {
        render.list(rows, (row) => spec.format(row, rowCtx));
      } else if (renderer.kind === 'table') {
        render.table(renderer.headers, rows.map((row) => spec.format(row, rowCtx)), renderer.dashWidths);
      } else {
        render.groupedByFile(
          rows,
          (row) => spec.format(row, rowCtx),
          renderer.key ? (row) => renderer.key!(row, rowCtx) : undefined,
        );
      }
    },
    after: spec.after,
  });
}

function runCommandOutput<Output, Ctx extends DbCommandContext>(
  ctx: Ctx,
  spec: CommandOutputSpec<Output, Ctx>,
): void {
  const output = spec.query(ctx);
  const emptyMessage = spec.emptyMessage?.(output, ctx);
  if (emptyMessage) {
    render.empty(emptyMessage);
    return;
  }
  if (spec.heuristicLabel) renderHeuristicNotice(spec.heuristicLabel);
  spec.render(output, ctx);
  spec.after?.(output, ctx);
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
