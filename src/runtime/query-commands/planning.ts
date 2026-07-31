import * as queries from '../../queries/index.js';
import { REPOSITORY_OBSERVATION_OPERATION } from '../command-operation.js';
import type { CommandDescriptor } from '../command-kit/command-descriptor-types.js';
import { doc, option, parseInteger, withCompactJsonOptions } from '../command-kit/command-spec-builders.js';
import {
  booleanOptionValue,
  budgetedDbCommand,
  definedLimitOption,
  definedNumberOption,
  printJsonEnvelope,
  stringArg,
  stringOptionValue,
} from '../command-kit/command-execution.js';
import { displayLine, displayPathRange, displayRange, render } from '../render.js';
import { resolveCliProjectContext } from '../cli-context.js';
import { symbolResolutionBefore, symbolResolutionEmptyMessage, symbolResolutionJson } from './symbol-resolution.js';

interface LimitedRows {
  rows: string[];
  omitted: number;
}

const handlePlanContext = budgetedDbCommand('plan-context', ({ db, args, opts, budget }) => {
  const limit = definedLimitOption(opts, 'limit', 20);
  const gitHead = resolveCliProjectContext(db.config.projectRoot).gitContext?.headCommit;
  const result = queries.planContext(db, stringArg(args, 0), {
    semantic: budget.semantic,
    impactDepth: definedNumberOption(opts, 'impactDepth', 3),
    sliceDepth: definedNumberOption(opts, 'sliceDepth', 3),
    scope: stringOptionValue(opts, 'scope'),
    ...(gitHead ? { gitHead } : {}),
  });

  if (result.warnings.length === 1 && result.warnings[0] === 'No symbol, file, or module matched target.') {
    if (booleanOptionValue(opts, 'json')) {
      printJsonEnvelope(
        'plan-context',
        args,
        opts,
        { ...symbolResolutionJson(db, stringArg(args, 0)), ...result },
        {
          analysisBudget: budget.analysisBudget,
          coverage: planContextCoverage(result),
          agentResult: planContextAgentResult(result),
        },
      );
      return;
    }
    return render.empty(symbolResolutionEmptyMessage(db, stringArg(args, 0)));
  }

  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope(
      'plan-context',
      args,
      opts,
      result.matched.symbol ? { ...symbolResolutionJson(db, stringArg(args, 0)), ...result } : result,
      {
        analysisBudget: budget.analysisBudget,
        coverage: planContextCoverage(result),
        agentResult: planContextAgentResult(result),
      },
    );
    return;
  }
  if (result.matched.symbol) symbolResolutionBefore(db, stringArg(args, 0));

  const sections = [
    { title: 'TARGET', rows: targetRows(result) },
    { title: 'DEFINITIONS', rows: definitionRows(result, limit), skipIfEmpty: true },
    { title: 'REFERENCES', rows: referenceRows(result, limit), skipIfEmpty: true },
    { title: 'CALL GRAPH', rows: callGraphRows(result, limit), skipIfEmpty: true },
    { title: 'DATAFLOW', rows: dataflowRows(result, limit), skipIfEmpty: true },
    { title: 'DEPENDENCIES', rows: dependencyRows(result, limit), skipIfEmpty: true },
    { title: 'SURFACE', rows: surfaceRows(result, limit), skipIfEmpty: true },
    { title: 'DOWNSTREAM IMPACT', rows: affectedRows(result, limit), skipIfEmpty: true },
    { title: 'CHANGE RISK', rows: riskRows(result, limit), skipIfEmpty: true },
    { title: 'HISTORY', rows: historyRows(result), skipIfEmpty: true },
    { title: 'PLANNING NOTES', rows: planningNoteRows(result), skipIfEmpty: true },
  ];

  render.sectionedReport(sections);
});

export const planningQueryCommandDescriptors: CommandDescriptor[] = [
  {
    id: 'plan-context',
    command: 'plan-context <target>',
    description: 'Pre-edit planning context for a symbol, file, or module',
    options: withCompactJsonOptions([
      option('--impact-depth <n>', 'Maximum affected traversal depth', parseInteger, 3),
      option('--slice-depth <n>', 'Maximum backward slice depth', parseInteger, 3),
      option('-s, --scope <path>', 'Limit downstream impact to files matching path'),
      option('-n, --limit <n>', 'Rows per section', parseInteger, 20),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ]),
    budget: 'semantic',
    agent: {
      operation: REPOSITORY_OBSERVATION_OPERATION,
      answers: [
        'What must I know before editing this target?',
        'Who consumes it, and what breaks if I change it?',
        'Has this target historically changed together with anything else?',
      ],
      returns: [
        'definitions and references',
        'callers and callees',
        'dataflow producers and consumers',
        'backward and forward slices',
        'affected symbols',
        'change-surface risk',
        'dependencies and reverse dependencies',
        'module files and exports',
        'external surface use',
        'complexity',
        'churn',
        'co-change partners',
        'active suppressions',
      ],
      inputs: [['symbol', 'file', 'module']],
      // Every section is capped by --limit (default 20), and traversal by
      // --impact-depth / --slice-depth (default 3). Always disclose the caps.
      coverage: 'bounded',
      contrasts: [
        {
          command: 'change-surface',
          distinction:
            'change-surface is the exports/consumers/risk briefing alone; plan-context embeds it alongside flow, slices, history, and reuse signals.',
        },
      ],
    },
    renderShape: 'custom',
    docs: doc('Planning', ['scip-query plan-context parseSymbol']),
    handler: handlePlanContext,
  },
];

function planContextCoverage(result: queries.PlanContextResult) {
  return {
    complete: false,
    totalKnown: false,
    returned: planContextReturnedUnits(result),
  } as const;
}

function planContextReturnedUnits(result: queries.PlanContextResult): number {
  return (
    result.trace.definitions.length +
    result.trace.referencedBy.length +
    (result.callGraph?.callers.length ?? 0) +
    (result.callGraph?.callees.length ?? 0) +
    (result.dataflow?.producers.length ?? 0) +
    (result.dataflow?.consumers.length ?? 0) +
    (result.dataflow?.usageSites.length ?? 0) +
    (result.backwardSlice?.connectedSymbols.length ?? 0) +
    (result.forwardSlice?.connectedSymbols.length ?? 0) +
    result.affected.length +
    result.deps.length +
    result.rdeps.length +
    result.system.files.length +
    result.system.symbols.length +
    result.system.dependsOn.length +
    result.system.dependedOnBy.length +
    result.surface.length
  );
}

function planContextAgentResult(result: queries.PlanContextResult) {
  return {
    target: result.target,
    matched: result.matched,
    counts: {
      definitions: result.trace.definitions.length,
      references: result.trace.referencedBy.length,
      callers: result.callGraph?.callers.length ?? 0,
      callees: result.callGraph?.callees.length ?? 0,
      producers: result.dataflow?.producers.length ?? 0,
      consumers: result.dataflow?.consumers.length ?? 0,
      backwardSlice: result.backwardSlice?.connectedSymbols.length ?? 0,
      forwardSlice: result.forwardSlice?.connectedSymbols.length ?? 0,
      affected: result.affected.length,
      dependencies: result.deps.length,
      reverseDependencies: result.rdeps.length,
      moduleFiles: result.system.files.length,
      externalSurfaceUses: result.surface.length,
      coChangePartners: result.history.coChangePartners.length,
    },
    warnings: result.warnings,
    changeSurface: result.changeSurface
      ? {
          file: result.changeSurface.file,
          totalExternalConsumers: result.changeSurface.totalExternalConsumers,
          fileRisk: result.changeSurface.fileRisk,
          riskCounts: {
            high: result.changeSurface.symbols.filter((symbol) => symbol.riskLevel === 'high').length,
            medium: result.changeSurface.symbols.filter((symbol) => symbol.riskLevel === 'medium').length,
            low: result.changeSurface.symbols.filter((symbol) => symbol.riskLevel === 'low').length,
          },
        }
      : null,
    history: result.history,
  };
}

function targetRows(result: queries.PlanContextResult): string[] {
  return [
    `Target: ${result.target}`,
    `Matched: symbol=${yesNo(result.matched.symbol)} file=${yesNo(result.matched.file)} module=${yesNo(result.matched.module)}`,
  ];
}

function definitionRows(result: queries.PlanContextResult, limit: number): string[] {
  const rows: string[] = [];
  for (const definition of result.trace.definitions) {
    const sig = definition.signature ? `  -- ${definition.signature}` : '';
    rows.push(`  ${displayPathRange(definition.relativePath, definition.startLine, definition.endLine)}${sig}`);
    if (definition.source) {
      rows.push(
        ...definition.source
          .split('\n')
          .map((line, index) => `    ${String(displayLine(definition.startLine + index)).padStart(4)}  ${line}`),
      );
    }
  }
  if (rows.length === 0) {
    rows.push(
      ...result.system.symbols.map(
        (symbol) => `  ${displayRange(symbol.startLine, symbol.endLine)}  ${symbol.shortName}`,
      ),
    );
  }
  return cappedRows(rows, limit).rows;
}

function referenceRows(result: queries.PlanContextResult, limit: number): string[] {
  const rows = result.trace.referencedBy.map(
    (ref) => `  ${ref.relativePath}:${displayLine(ref.line)}  in ${ref.enclosingShort}`,
  );
  return withOmitted(cappedRows(rows, limit));
}

function callGraphRows(result: queries.PlanContextResult, limit: number): string[] {
  if (!result.callGraph) return [];
  const callerRows = result.callGraph.callers.map((caller) => `  caller  ${caller.file}  ${caller.shortName}`);
  const calleeRows = result.callGraph.callees.map((callee) => `  callee  ${callee.file}  ${callee.shortName}`);
  return withOmitted(cappedRows([...callerRows, ...calleeRows], limit));
}

function dataflowRows(result: queries.PlanContextResult, limit: number): string[] {
  if (!result.dataflow) return [];
  const producerRows = result.dataflow.producers.map(
    (producer) => `  producer  ${producer.file}  ${producer.shortName}`,
  );
  const consumerRows = result.dataflow.consumers.map(
    (consumer) => `  consumer  ${consumer.file}  ${consumer.shortName}`,
  );
  const usageRows = result.dataflow.usageSites.map(
    (usage) => `  usage     ${usage.file}:${displayLine(usage.line)}  in ${usage.enclosingShort}`,
  );
  return withOmitted(cappedRows([...producerRows, ...consumerRows, ...usageRows], limit));
}

function dependencyRows(result: queries.PlanContextResult, limit: number): string[] {
  const rows = [
    ...result.deps.map((dep) => `  file depends on      ${dep.relativePath}`),
    ...result.rdeps.map((dep) => `  file depended on by  ${dep.relativePath}`),
    ...result.system.dependsOn.map((dep) => `  module depends on    ${dep}`),
    ...result.system.dependedOnBy.map((dep) => `  module used by       ${dep}`),
  ];
  return withOmitted(cappedRows(rows, limit));
}

function surfaceRows(result: queries.PlanContextResult, limit: number): string[] {
  const rows = [
    ...result.system.files.map((file) => `  file    ${file}`),
    ...result.system.symbols.map(
      (symbol) => `  export  ${displayRange(symbol.startLine, symbol.endLine)}  ${symbol.shortName}`,
    ),
    ...result.surface.map((surface) => `  use     ${surface.consumer} -> ${surface.shortName}`),
  ];
  return withOmitted(cappedRows(rows, limit));
}

function affectedRows(result: queries.PlanContextResult, limit: number): string[] {
  const rows: string[] = [];
  let prevDepth = -1;
  for (const affected of result.affected) {
    if (affected.depth !== prevDepth) {
      rows.push(`  -- Depth ${affected.depth} --`);
      prevDepth = affected.depth;
    }
    rows.push(`  ${affected.file}  ${affected.shortName}`);
  }
  return withOmitted(cappedRows(rows, limit));
}

function riskRows(result: queries.PlanContextResult, limit: number): string[] {
  const rows: string[] = [];
  if (result.changeSurface) {
    rows.push(`  File: ${result.changeSurface.file}`);
    rows.push(`  External consumers: ${result.changeSurface.totalExternalConsumers}`);
    if (result.changeSurface.fileRisk && result.changeSurface.fileRisk.reasons.length > 0) {
      rows.push(
        `  File risk factors (${result.changeSurface.fileRisk.coverage} metadata): ${result.changeSurface.fileRisk.reasons
          .map((reason) => `${reason.kind}: ${reason.detail}`)
          .join('; ')}`,
      );
    }
    rows.push(
      ...result.changeSurface.symbols.map((symbol) => {
        const risk =
          symbol.riskLevel === 'high' ? ' *** HIGH RISK ***' : symbol.riskLevel === 'medium' ? ' * medium risk *' : '';
        const riskReasons = symbol.riskReasons ?? [];
        const reasons =
          riskReasons.length === 0
            ? ''
            : `  [why: ${riskReasons.map((reason) => `${reason.kind}: ${reason.detail}`).join('; ')}]`;
        return `  ${displayRange(symbol.startLine, symbol.endLine)}  ${symbol.shortName}  [${symbol.externalConsumers} consumers]${risk}${reasons}`;
      }),
    );
  }
  if (result.complexity) {
    rows.push(
      `  Complexity: ${displayPathRange(result.complexity.relativePath, result.complexity.startLine, result.complexity.endLine)}  ${result.complexity.shortName}`,
    );
    rows.push(`  LOC: ${result.complexity.loc}`);
    rows.push(`  Branches: ${result.complexity.branches}`);
    rows.push(`  Cyclomatic estimate: ${result.complexity.cyclomaticEstimate}`);
    rows.push(`  Callees: ${result.complexity.calleeCount}`);
    rows.push(`  Fan-in: ${result.complexity.fanIn}`);
    rows.push(`  Fan-out: ${result.complexity.fanOut}`);
  }
  return withOmitted(cappedRows(rows, limit));
}

function historyRows(result: queries.PlanContextResult): string[] {
  const history = result.history;
  if (!history.available || !history.file) return [];
  const rows: string[] = [];
  if (history.churn) {
    const fixes = history.churn.fixChanges > 0 ? `, ${history.churn.fixChanges} in fix commits` : '';
    rows.push(`  Churn: ${history.churn.changes} change(s) in recent history${fixes}`);
  }
  for (const partner of history.coChangePartners) {
    rows.push(
      `  Usually changes with: ${partner.file}  (${partner.together}x, ${Math.round(partner.confidence * 100)}%)`,
    );
  }
  if (history.suppressionsInFile > 0) {
    rows.push(
      `  Detector suppressions in file: ${history.suppressionsInFile} (accepted findings — read the reasons before refactoring)`,
    );
  }
  return rows;
}

function planningNoteRows(result: queries.PlanContextResult): string[] {
  const rows = result.warnings.map((warning) => `  ${warning}`);
  if (result.history.coChangePartners.length > 0) {
    rows.push('  Check the HISTORY co-change partners — editing this file usually means editing them too.');
  }
  const highRiskSymbols = result.changeSurface?.symbols.filter((symbol) => symbol.riskLevel === 'high') ?? [];
  if (highRiskSymbols.length > 0) {
    rows.push('  Inspect high-risk consumers before editing public behavior.');
  }
  if (result.changeSurface?.fileRisk?.operationalRoot) {
    rows.push(
      '  This file is an operational root; validate its launch and shutdown path even when source fan-in is zero.',
    );
  }
  if (result.affected.length > 0) {
    rows.push('  Validate downstream consumers at the shallowest affected depths first.');
  }
  return rows;
}

function cappedRows(rows: readonly string[], limit: number): LimitedRows {
  const normalizedLimit = Math.max(1, limit);
  return {
    rows: rows.slice(0, normalizedLimit),
    omitted: Math.max(0, rows.length - normalizedLimit),
  };
}

function withOmitted(result: LimitedRows): string[] {
  return result.omitted > 0 ? [...result.rows, `  ... ${result.omitted} more`] : result.rows;
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}
