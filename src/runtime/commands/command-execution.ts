import type { ScipDatabase } from '../../storage/db.js';
import type { CommandHandler } from './command-descriptor-types.js';
import type { CommandEvidenceTier } from './command-descriptor-types.js';
import { withDb } from '../cli-context.js';
import { commandAnalysisBudget, renderHeuristicNotice, type AnalysisBudgetDisclosure } from '../cli-support.js';
import { render } from '../render.js';
import type { ReportSection } from '../render.js';

export type CommandOptions = Record<string, unknown>;
const OPTION_VALUE_SOURCE = Symbol('option-value-source');
type CommandOptionsWithSources = CommandOptions & {
  [OPTION_VALUE_SOURCE]?: (key: string) => string | undefined;
};

let commandEvidenceById = new Map<string, CommandEvidenceTier>();

export function setCommandEvidenceMap(entries: ReadonlyMap<string, CommandEvidenceTier>): void {
  commandEvidenceById = new Map(entries);
}

export interface DbCommandContext {
  db: ScipDatabase;
  args: readonly unknown[];
  opts: CommandOptions;
}

export interface BudgetedCommandContext extends DbCommandContext {
  budget: ReturnType<typeof commandAnalysisBudget>;
}

interface RowCommandSpec<Row, Ctx extends DbCommandContext> {
  commandName?: string;
  query: (ctx: Ctx) => readonly Row[];
  format: (row: Row, ctx: Ctx) => string;
  emptyMessage?: (ctx: Ctx) => string;
  heuristicLabel?: string;
  before?: (rows: readonly Row[], ctx: Ctx) => void;
  toJson?: (rows: readonly Row[], ctx: Ctx) => unknown;
  after?: (rows: readonly Row[], ctx: Ctx) => void;
}

type RowRenderer<Row, Ctx extends DbCommandContext> =
  | { kind: 'list' }
  | { kind: 'table'; headers: readonly string[]; dashWidths?: readonly number[] }
  | { kind: 'grouped'; key?: (row: Row, ctx: Ctx) => string };

export interface ReportCommandSpec<Result, Ctx extends DbCommandContext = DbCommandContext> {
  commandName?: string;
  query: (ctx: Ctx) => Result;
  emptyMessage?: (result: Result, ctx: Ctx) => string | undefined;
  heuristicLabel?: string;
  before?: (result: Result, ctx: Ctx) => void;
  render: (result: Result, ctx: Ctx) => void;
  toJson?: (result: Result, ctx: Ctx) => unknown;
  after?: (result: Result, ctx: Ctx) => void;
}

export interface SectionedReportCommandSpec<Result, Ctx extends DbCommandContext = DbCommandContext> {
  commandName?: string;
  query: (ctx: Ctx) => Result;
  emptyMessage?: (result: Result, ctx: Ctx) => string | undefined;
  heuristicLabel?: string;
  before?: (result: Result, ctx: Ctx) => void;
  sections: (result: Result, ctx: Ctx) => readonly ReportSection[];
  toJson?: (result: Result, ctx: Ctx) => unknown;
  after?: (result: Result, ctx: Ctx) => void;
}

interface CommandOutputSpec<Output, Ctx extends DbCommandContext> {
  commandName?: string;
  query: (ctx: Ctx) => Output;
  emptyMessage?: (output: Output, ctx: Ctx) => string | undefined;
  heuristicLabel?: string;
  before?: (output: Output, ctx: Ctx) => void;
  render: (output: Output, ctx: Ctx) => void;
  toJson?: (output: Output, ctx: Ctx) => unknown;
  after?: (output: Output, ctx: Ctx) => void;
}

export function dbCommand(run: (ctx: DbCommandContext) => void): CommandHandler {
  return (...rawArgs: unknown[]) => {
    const { args, opts } = splitCommanderActionArgs(rawArgs);
    withDb((db) => run({ db, args, opts }));
  };
}

export function budgetedDbCommand(commandName: string, run: (ctx: BudgetedCommandContext) => void): CommandHandler {
  return dbCommand((ctx) => {
    const budget = commandAnalysisBudget(ctx.db, commandName, booleanOptionValue(ctx.opts, 'full'), {
      quiet: booleanOptionValue(ctx.opts, 'json'),
    });
    run({ ...ctx, budget });
  });
}

export function listCommand<Row>(spec: RowCommandSpec<Row, DbCommandContext>): CommandHandler {
  return dbCommand((ctx) => renderRows(ctx, spec, { kind: 'list' }));
}

export function tableCommand<Row>(
  spec: RowCommandSpec<Row, DbCommandContext> & {
    headers: readonly string[];
    dashWidths?: readonly number[];
  },
): CommandHandler {
  return dbCommand((ctx) =>
    renderRows(ctx, spec, { kind: 'table', headers: spec.headers, dashWidths: spec.dashWidths }),
  );
}

export function groupedByFileCommand<Row>(
  spec: RowCommandSpec<Row, DbCommandContext> & {
    key?: (row: Row, ctx: DbCommandContext) => string;
  },
): CommandHandler {
  return dbCommand((ctx) => renderRows(ctx, spec, { kind: 'grouped', key: spec.key }));
}

export function reportCommand<Result>(spec: ReportCommandSpec<Result>): CommandHandler {
  return dbCommand((ctx) => runCommandOutput(ctx, spec));
}

export function sectionedReportCommand<Result>(spec: SectionedReportCommandSpec<Result>): CommandHandler {
  return reportCommand({
    commandName: spec.commandName,
    query: spec.query,
    emptyMessage: spec.emptyMessage,
    heuristicLabel: spec.heuristicLabel,
    before: spec.before,
    render: (result, ctx) => render.sectionedReport(spec.sections(result, ctx)),
    toJson: spec.toJson,
    after: spec.after,
  });
}

export function budgetedReportCommand<Result>(
  commandName: string,
  spec: ReportCommandSpec<Result, BudgetedCommandContext>,
): CommandHandler {
  return budgetedDbCommand(commandName, (ctx) =>
    runCommandOutput(ctx, { ...spec, commandName: spec.commandName ?? commandName }),
  );
}

export function budgetedSectionedReportCommand<Result>(
  commandName: string,
  spec: SectionedReportCommandSpec<Result, BudgetedCommandContext>,
): CommandHandler {
  return budgetedReportCommand(commandName, {
    commandName: spec.commandName ?? commandName,
    query: spec.query,
    emptyMessage: spec.emptyMessage,
    heuristicLabel: spec.heuristicLabel,
    before: spec.before,
    render: (result, ctx) => render.sectionedReport(spec.sections(result, ctx)),
    toJson: spec.toJson,
    after: spec.after,
  });
}

export function budgetedListCommand<Row>(
  commandName: string,
  spec: RowCommandSpec<Row, BudgetedCommandContext>,
): CommandHandler {
  return budgetedDbCommand(commandName, (ctx) => renderRows(ctx, { ...spec, commandName }, { kind: 'list' }));
}

export function budgetedTableCommand<Row>(
  commandName: string,
  spec: RowCommandSpec<Row, BudgetedCommandContext> & {
    headers: readonly string[];
    dashWidths?: readonly number[];
  },
): CommandHandler {
  return budgetedDbCommand(commandName, (ctx) =>
    renderRows(ctx, { ...spec, commandName }, { kind: 'table', headers: spec.headers, dashWidths: spec.dashWidths }),
  );
}

export function budgetedGroupedByFileCommand<Row>(
  commandName: string,
  spec: RowCommandSpec<Row, BudgetedCommandContext> & {
    key?: (row: Row, ctx: BudgetedCommandContext) => string;
  },
): CommandHandler {
  return budgetedDbCommand(commandName, (ctx) =>
    renderRows(ctx, { ...spec, commandName }, { kind: 'grouped', key: spec.key }),
  );
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

export function stringArrayOptionValue(opts: CommandOptions, key: string): string[] {
  const value = opts[key];
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}

export function definedNumberOption(opts: CommandOptions, key: string, fallback: number): number {
  return numberOptionValue(opts, key) ?? fallback;
}

export function definedLimitOption(opts: CommandOptions, key: string, fallback: number): number {
  const explicitLimit = numberOptionValue(opts, key);
  const hasUserLimit = explicitLimit !== undefined && optionValueSource(opts, key) !== 'default';
  if (booleanOptionValue(opts, 'full')) {
    if (hasUserLimit) {
      throw new Error(
        '--full cannot be combined with --limit. Use --full for all findings, or --limit N for a capped report.',
      );
    }
    return Number.POSITIVE_INFINITY;
  }
  return explicitLimit ?? fallback;
}

export function optionValueSource(opts: CommandOptions, key: string): string | undefined {
  return (opts as CommandOptionsWithSources)[OPTION_VALUE_SOURCE]?.(key);
}

function renderRows<Row, Ctx extends DbCommandContext>(
  ctx: Ctx,
  spec: RowCommandSpec<Row, Ctx>,
  renderer: RowRenderer<Row, Ctx>,
): void {
  runCommandOutput(ctx, {
    commandName: spec.commandName,
    query: spec.query,
    emptyMessage: (rows, rowCtx) => (rows.length === 0 && spec.emptyMessage ? spec.emptyMessage(rowCtx) : undefined),
    heuristicLabel: spec.heuristicLabel,
    render: (rows, rowCtx) => {
      if (renderer.kind === 'list') {
        render.list(rows, (row) => spec.format(row, rowCtx));
      } else if (renderer.kind === 'table') {
        render.table(
          renderer.headers,
          rows.map((row) => spec.format(row, rowCtx)),
          renderer.dashWidths,
        );
      } else {
        render.groupedByFile(
          rows,
          (row) => spec.format(row, rowCtx),
          renderer.key ? (row) => renderer.key!(row, rowCtx) : undefined,
        );
      }
    },
    toJson: spec.toJson,
    before: spec.before,
    after: spec.after,
  });
}

function runCommandOutput<Output, Ctx extends DbCommandContext>(ctx: Ctx, spec: CommandOutputSpec<Output, Ctx>): void {
  const output = spec.query(ctx);
  if (booleanOptionValue(ctx.opts, 'json')) {
    printJsonEnvelope(spec.commandName, ctx.args, ctx.opts, spec.toJson ? spec.toJson(output, ctx) : output, {
      analysisBudget: budgetedContextAnalysisBudget(ctx),
    });
    return;
  }
  const emptyMessage = spec.emptyMessage?.(output, ctx);
  if (emptyMessage) {
    render.empty(emptyMessage);
    return;
  }
  if (spec.heuristicLabel) renderHeuristicNotice(spec.heuristicLabel);
  spec.before?.(output, ctx);
  spec.render(output, ctx);
  spec.after?.(output, ctx);
}

/**
 * Reads `ctx.budget.analysisBudget` when present (BudgetedCommandContext) —
 * `undefined` on a plain DbCommandContext, or when the index is small enough
 * that no cap engaged. Kept next to printJsonEnvelope so every JSON-emitting
 * command that goes through the shared `runCommandOutput`/`renderRows`
 * pipeline gets the disclosure "for free," the same way `evidence` does.
 */
function budgetedContextAnalysisBudget(ctx: DbCommandContext): AnalysisBudgetDisclosure | undefined {
  const budget = (ctx as Partial<BudgetedCommandContext>).budget;
  return budget?.analysisBudget;
}

export function printJsonEnvelope(
  command: string | undefined,
  args: readonly unknown[],
  options: CommandOptions,
  result: unknown,
  extra: { analysisBudget?: AnalysisBudgetDisclosure } = {},
): void {
  const evidence = command ? commandEvidenceById.get(command) : undefined;
  console.log(
    JSON.stringify(
      {
        command,
        ...(evidence ? { evidence } : {}),
        ...(extra.analysisBudget ? { analysisBudget: extra.analysisBudget } : {}),
        args: jsonPositionals(args),
        options,
        result,
      },
      null,
      2,
    ),
  );
}

function jsonPositionals(args: readonly unknown[]): readonly unknown[] {
  return args.filter((arg) => typeof arg === 'string' || typeof arg === 'number' || typeof arg === 'boolean');
}

export function splitCommanderActionArgs(rawArgs: readonly unknown[]): {
  args: readonly unknown[];
  opts: CommandOptions;
} {
  if (rawArgs.length === 0) return { args: [], opts: {} };
  const tail = rawArgs[rawArgs.length - 1];
  return {
    args: rawArgs.slice(0, -1),
    opts: commandOptions(tail),
  };
}

export function commandOptions(value: unknown): CommandOptions {
  if (!value || typeof value !== 'object') return {};
  const maybeCommand = value as {
    opts?: () => unknown;
    getOptionValueSource?: (key: string) => string | undefined;
  };
  if (typeof maybeCommand.opts === 'function') {
    const opts = maybeCommand.opts();
    if (!opts || typeof opts !== 'object') return {};
    if (typeof maybeCommand.getOptionValueSource === 'function') {
      Object.defineProperty(opts, OPTION_VALUE_SOURCE, {
        value: (key: string) => maybeCommand.getOptionValueSource!(key),
        enumerable: false,
      });
    }
    return opts as CommandOptions;
  }
  return value as CommandOptions;
}
