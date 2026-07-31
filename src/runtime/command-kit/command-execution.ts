import { AsyncLocalStorage } from 'node:async_hooks';
import type { ScipDatabase } from '../../storage/db.js';
import {
  operationObservesRepository,
  resolveCommandOperationRole,
  type CommandOperationRole,
} from '../command-operation.js';
import type {
  CommandAgentContract,
  CommandEvidenceTier,
  CommandHandler,
  InvocationCoverage,
} from './command-descriptor-types.js';
import { deriveClaimQualification, type CommandClaimContract } from '../claim-qualification.js';
import { currentCliDatabase, withDb } from '../cli-context.js';
import {
  cliVersion,
  commandAnalysisBudget,
  renderHeuristicNotice,
  type AnalysisBudgetDisclosure,
} from '../cli-support.js';
import {
  CLI_ANALYSIS_MANIFEST_SCHEMA_VERSION,
  CLI_EVIDENCE_CONTEXT_SCHEMA_VERSION,
  createCliJsonEnvelope,
  serializeCliJsonEnvelope,
  type CliEvidenceContextV1,
} from '../cli-json-envelope.js';
import { buildObservationReceipt, type ObservationReceiptV2 } from '../observation-receipt.js';
import { render, writeSerializedJson } from '../render.js';
import type { ReportSection } from '../render.js';

export type CommandOptions = Record<string, unknown>;
const OPTION_VALUE_SOURCE = Symbol('option-value-source');
type CommandOptionsWithSources = CommandOptions & {
  [OPTION_VALUE_SOURCE]?: (key: string) => string | undefined;
};

let commandEvidenceById = new Map<string, CommandEvidenceTier>();
let commandAgentContractById = new Map<string, CommandAgentContract>();
let commandClaimContractById = new Map<string, CommandClaimContract>();
const commandOperationStorage = new AsyncLocalStorage<CommandOperationRole>();

/**
 * Bind the role selected from parsed invocation arguments before the handler
 * runs. AsyncLocalStorage keeps concurrent embedded CLI invocations isolated.
 */
export function runWithCommandOperationRole<T>(role: CommandOperationRole, run: () => T): T {
  return commandOperationStorage.run(role, run);
}

export function setCommandEvidenceMap(entries: ReadonlyMap<string, CommandEvidenceTier>): void {
  commandEvidenceById = new Map(entries);
}

export function setCommandAgentContractMap(entries: ReadonlyMap<string, CommandAgentContract>): void {
  commandAgentContractById = new Map(entries);
}

export function setCommandClaimContractMap(entries: ReadonlyMap<string, CommandClaimContract>): void {
  commandClaimContractById = new Map(entries);
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
  coverage?: (rows: readonly Row[], ctx: Ctx) => InvocationCoverage;
  agentResult?: (rows: readonly Row[], ctx: Ctx) => unknown;
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
  coverage?: (result: Result, ctx: Ctx) => InvocationCoverage;
  agentResult?: (result: Result, ctx: Ctx) => unknown;
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
  coverage?: (result: Result, ctx: Ctx) => InvocationCoverage;
  agentResult?: (result: Result, ctx: Ctx) => unknown;
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
  coverage?: (output: Output, ctx: Ctx) => InvocationCoverage;
  agentResult?: (output: Output, ctx: Ctx) => unknown;
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
    coverage: spec.coverage,
    agentResult: spec.agentResult,
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
    coverage: spec.coverage,
    agentResult: spec.agentResult,
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
    // Keep the unbounded sentinel finite: several query paths bind this value
    // directly to SQLite's LIMIT parameter, which rejects JavaScript Infinity.
    // MAX_SAFE_INTEGER remains effectively unbounded for both SQL and slice().
    return Number.MAX_SAFE_INTEGER;
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
    coverage: spec.coverage,
    agentResult: spec.agentResult,
    before: spec.before,
    after: spec.after,
  });
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
function runCommandOutput<Output, Ctx extends DbCommandContext>(ctx: Ctx, spec: CommandOutputSpec<Output, Ctx>): void {
  const output = spec.query(ctx);
  if (booleanOptionValue(ctx.opts, 'json')) {
    if (!spec.commandName) {
      throw new Error('JSON output requires a command name so its result contract can be identified.');
    }
    printJsonEnvelope(spec.commandName, ctx.args, ctx.opts, spec.toJson ? spec.toJson(output, ctx) : output, {
      analysisBudget: budgetedContextAnalysisBudget(ctx),
      coverage: spec.coverage?.(output, ctx),
      agentResult: spec.agentResult?.(output, ctx),
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
  command: string,
  args: readonly unknown[],
  options: CommandOptions,
  result: unknown,
  extra: {
    analysisBudget?: AnalysisBudgetDisclosure;
    coverage?: InvocationCoverage;
    agentResult?: unknown;
    resultSchemaVersion?: number;
    resultOnly?: unknown;
    observationReceipt?: ObservationReceiptV2;
  } = {},
): void {
  const evidence = commandEvidenceById.get(command);
  const contract = commandAgentContractById.get(command);
  const claimContract = commandClaimContractById.get(command);
  const declaredOperationRole = contract
    ? resolveCommandOperationRole(contract.operation, { args, options })
    : undefined;
  const selectedOperationRole = commandOperationStorage.getStore();
  if (
    selectedOperationRole !== undefined &&
    declaredOperationRole !== undefined &&
    selectedOperationRole !== declaredOperationRole
  ) {
    throw new Error(
      `Command ${command} changed operation role during execution: selected ${selectedOperationRole}, rendered ${declaredOperationRole}.`,
    );
  }
  const operationRole = selectedOperationRole ?? declaredOperationRole;
  const resolution = invocationResolutionCoverage(result);
  const baseCoverage = extra.coverage ?? defaultInvocationCoverage(contract, result, extra.analysisBudget);
  const coverage =
    baseCoverage && resolution && !baseCoverage.resolution ? { ...baseCoverage, resolution } : baseCoverage;
  if (coverage) validateInvocationCoverage(coverage);
  if (booleanOptionValue(options, 'resultOnly')) {
    const resultOnly = Object.hasOwn(extra, 'resultOnly') ? extra.resultOnly : result;
    writeSerializedJson(JSON.stringify(resultOnly, null, booleanOptionValue(options, 'compact') ? 0 : 2));
    return;
  }
  const envelope = createCliJsonEnvelope({
    producerVersion: cliVersion,
    command,
    ...(operationRole ? { operationRole } : {}),
    ...(evidence ? { evidence } : {}),
    ...(extra.analysisBudget ? { analysisBudget: extra.analysisBudget } : {}),
    args: jsonPositionals(args),
    options,
    result,
    ...(coverage ? { coverage } : {}),
    ...(extra.agentResult !== undefined ? { agentResult: extra.agentResult } : {}),
    ...optionalEvidenceContext(
      operationRole,
      evidence,
      extra.analysisBudget,
      coverage,
      claimContract,
      extra.observationReceipt,
    ),
    ...(extra.resultSchemaVersion === undefined ? {} : { resultSchemaVersion: extra.resultSchemaVersion }),
  });
  writeSerializedJson(serializeCliJsonEnvelope(envelope, booleanOptionValue(options, 'compact')));
}

function optionalEvidenceContext(
  operationRole: CommandOperationRole | undefined,
  evidence: CommandEvidenceTier | undefined,
  analysisBudget: AnalysisBudgetDisclosure | undefined,
  coverage: InvocationCoverage | undefined,
  claimContract: CommandClaimContract | undefined,
  suppliedReceipt: ObservationReceiptV2 | undefined,
): { evidenceContext?: CliEvidenceContextV1 } {
  if (!operationRole || !operationObservesRepository(operationRole)) return {};
  const db = currentCliDatabase();
  const receipt =
    suppliedReceipt ??
    (db
      ? buildObservationReceipt({
          projectRoot: db.config.projectRoot,
          db,
          ...(claimContract ? { observedSourceKinds: claimContract.observedSources } : {}),
        })
      : undefined);
  if (!receipt) return {};
  return {
    evidenceContext: {
      schemaVersion: CLI_EVIDENCE_CONTEXT_SCHEMA_VERSION,
      operationRole,
      receipt,
      analysisManifest: {
        schemaVersion: CLI_ANALYSIS_MANIFEST_SCHEMA_VERSION,
        ...(evidence ? { evidence } : {}),
        ...(analysisBudget ? { analysisBudget } : {}),
        ...(coverage ? { coverage } : {}),
        ...(claimContract
          ? {
              claimQualification: deriveClaimQualification({
                contract: claimContract,
                receipt,
                ...(coverage ? { coverage } : {}),
              }),
            }
          : {}),
      },
    },
  };
}

export function validateInvocationCoverage(coverage: InvocationCoverage): void {
  if (!Number.isSafeInteger(coverage.returned) || coverage.returned < 0) {
    throw new Error('Invocation coverage returned count must be a non-negative safe integer.');
  }
  if (coverage.complete !== true && coverage.complete !== false && coverage.complete !== null) {
    throw new Error('Invocation coverage complete must be true, false, or null.');
  }
  if (coverage.complete === true) {
    if (!coverage.totalKnown) {
      throw new Error('Complete invocation coverage must know its total.');
    }
    if (!Number.isSafeInteger(coverage.total) || coverage.total !== coverage.returned) {
      throw new Error('Complete invocation coverage total must equal returned.');
    }
    if (coverage.omitted !== 0) {
      throw new Error('Complete invocation coverage cannot omit results.');
    }
    if (coverage.omittedIdentities !== undefined) {
      throw new Error('Complete invocation coverage cannot name omitted identities.');
    }
    if (coverage.continuation !== undefined) {
      throw new Error('Complete invocation coverage cannot provide a continuation.');
    }
  } else if (coverage.totalKnown) {
    if (coverage.complete !== false) {
      throw new Error('Known incomplete invocation coverage must set complete to false.');
    }
    if (!Number.isSafeInteger(coverage.total) || coverage.total < coverage.returned) {
      throw new Error('Known invocation coverage total must be a safe integer at least as large as returned.');
    }
    const omitted = coverage.total - coverage.returned;
    if (coverage.omitted !== omitted) {
      throw new Error('Known invocation coverage omitted count must equal total minus returned.');
    }
    if (omitted === 0) {
      throw new Error('Known incomplete invocation coverage must omit at least one result.');
    }
    if (coverage.omittedIdentities && coverage.omittedIdentities.length !== omitted) {
      throw new Error('Omitted identity count must equal the disclosed omitted count.');
    }
  } else {
    if (coverage.total !== undefined || coverage.omitted !== undefined) {
      throw new Error('Unknown invocation coverage cannot claim a total or omitted count.');
    }
    if (coverage.omittedIdentities !== undefined) {
      throw new Error('Unknown invocation coverage cannot claim omitted identities.');
    }
  }
  if (coverage.continuation) {
    if (coverage.continuation.cursor.length === 0 || coverage.continuation.indexGeneration.length === 0) {
      throw new Error('Invocation coverage continuation requires a cursor and index generation.');
    }
  }
  if (coverage.resolution) {
    if (!Number.isSafeInteger(coverage.resolution.totalCandidates) || coverage.resolution.totalCandidates < 0) {
      throw new Error('Invocation resolution candidate count must be a non-negative safe integer.');
    }
    if (coverage.resolution.state === 'exact' && coverage.resolution.totalCandidates !== 1) {
      throw new Error('Exact invocation resolution must name exactly one candidate.');
    }
    if (coverage.resolution.state === 'missing' && coverage.resolution.totalCandidates !== 0) {
      throw new Error('Missing invocation resolution cannot name candidates.');
    }
    if (coverage.resolution.state === 'ambiguous' && coverage.resolution.totalCandidates < 2) {
      throw new Error('Ambiguous invocation resolution must name at least two candidates.');
    }
  }
}

function defaultInvocationCoverage(
  contract: CommandAgentContract | undefined,
  result: unknown,
  analysisBudget: AnalysisBudgetDisclosure | undefined,
): InvocationCoverage | undefined {
  if (!contract) return undefined;
  const returned = countReturnedUnits(contract, result);
  if (contract.coverage === 'complete') {
    return { complete: true, totalKnown: true, returned, total: returned, omitted: 0 };
  }
  if (contract.coverage === 'sampled') {
    return { complete: false, totalKnown: false, returned };
  }
  if (contract.coverage === 'bounded' && analysisBudget) {
    return { complete: false, totalKnown: false, returned };
  }
  return { complete: null, totalKnown: false, returned };
}

function countReturnedUnits(contract: CommandAgentContract, result: unknown): number {
  const policy = contract.resultUnits ?? { kind: 'report' as const };
  if (policy.kind === 'rows') return Array.isArray(result) ? result.length : 0;
  if (policy.kind === 'field') {
    if (!result || typeof result !== 'object') return 0;
    const value = (result as Record<string, unknown>)[policy.field];
    return Array.isArray(value) ? value.length : value === undefined || value === null ? 0 : 1;
  }
  return result === undefined || result === null ? 0 : 1;
}

function invocationResolutionCoverage(result: unknown): NonNullable<InvocationCoverage['resolution']> | undefined {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const record = result as Record<string, unknown>;
  if (record['matched'] === false) return { state: 'missing', totalCandidates: 0 };
  if (record['matched'] !== true || !Number.isSafeInteger(record['totalMatches'])) return undefined;
  const totalCandidates = record['totalMatches'] as number;
  if (totalCandidates <= 0) return { state: 'missing', totalCandidates: 0 };
  return totalCandidates === 1 ? { state: 'exact', totalCandidates } : { state: 'ambiguous', totalCandidates };
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
