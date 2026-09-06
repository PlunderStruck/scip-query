import * as queries from '../../queries/index.js';
import { REPOSITORY_OBSERVATION_OPERATION } from '../command-operation.js';
import type { CommandDescriptor } from '../command-kit/command-descriptor-types.js';
import {
  analysisSemanticContract,
  doc,
  fixedClaimFamily,
  mixedClaimContract,
  option,
  parseInteger,
  withCompactJsonOptions,
} from '../command-kit/command-spec-builders.js';
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

const handleContext = budgetedDbCommand('context', ({ db, args, opts, budget }) => {
  const limit = definedLimitOption(opts, 'limit', 20);
  const gitHead = resolveCliProjectContext(db.config.projectRoot).gitContext?.headCommit;
  const result = queries.repositoryContext(db, stringArg(args, 0), {
    semantic: budget.semantic,
    impactDepth: definedNumberOption(opts, 'impactDepth', 3),
    scope: stringOptionValue(opts, 'scope'),
    ...(gitHead ? { gitHead } : {}),
  });

  if (result.warnings.length === 1 && result.warnings[0] === 'No symbol, file, or module matched target.') {
    if (booleanOptionValue(opts, 'json')) {
      printJsonEnvelope(
        'context',
        args,
        opts,
        { ...symbolResolutionJson(db, stringArg(args, 0)), ...result },
        {
          analysisBudget: budget.analysisBudget,
          coverage: repositoryContextCoverage(result),
          agentResult: repositoryContextAgentResult(result),
        },
      );
      return;
    }
    return render.empty(symbolResolutionEmptyMessage(db, stringArg(args, 0)));
  }

  if (booleanOptionValue(opts, 'json')) {
    const resolutionTarget = result.primaryCallable?.symbol ?? stringArg(args, 0);
    printJsonEnvelope(
      'context',
      args,
      opts,
      result.matched.symbol ? { ...symbolResolutionJson(db, resolutionTarget), ...result } : result,
      {
        analysisBudget: budget.analysisBudget,
        coverage: repositoryContextCoverage(result),
        agentResult: repositoryContextAgentResult(result),
      },
    );
    return;
  }
  if (result.matched.symbol) symbolResolutionBefore(db, result.primaryCallable?.symbol ?? stringArg(args, 0));

  const sections = booleanOptionValue(opts, 'detail')
    ? detailedRepositoryContextSections(result, limit)
    : repositoryContextDecisionSections(result, stringArg(args, 0), limit, definedNumberOption(opts, 'impactDepth', 3));

  render.sectionedReport(sections);
});

export const planningQueryCommandDescriptors: CommandDescriptor[] = [
  {
    id: 'context',
    command: 'context <target>',
    description: 'Compiler-backed context for a symbol, file, or module',
    options: withCompactJsonOptions([
      option('--impact-depth <n>', 'Maximum affected traversal depth', parseInteger, 3),
      option('-s, --scope <path>', 'Limit downstream impact to files matching path'),
      option('-n, --limit <n>', 'Rows per section', parseInteger, 20),
      option('--detail', 'Render every planning component instead of the compact decision packet'),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ]),
    budget: 'semantic',
    claims: mixedClaimContract(
      ['index-generation', 'live-workspace'],
      [
        fixedClaimFamily('compiler-graph', 'trace', 'compiler-graph'),
        fixedClaimFamily('change-history', 'history', 'change-history'),
        fixedClaimFamily('planning-notes', 'warnings[]', 'heuristic'),
      ],
    ),
    agent: {
      operation: REPOSITORY_OBSERVATION_OPERATION,
      answers: [
        'How is this target connected to the rest of the repository?',
        'Who consumes it, and what breaks if I change it?',
        'Has this target historically changed together with anything else?',
      ],
      returns: [
        'definitions and references',
        'callers and callees',
        'affected symbols',
        'change-surface risk',
        'dependencies and reverse dependencies',
        'module files and exports',
        'external surface use',
        'complexity',
        'churn',
        'co-change partners',
        'active suppressions',
        'reuse candidates with evidence class and action tier',
        'possible shared owners found from a bounded scan of affected consumers',
      ],
      inputs: [['symbol', 'file', 'module']],
      // Every section is capped by --limit (default 20), and traversal by
      // --impact-depth / --reference-depth (default 3). Always disclose the caps.
      coverage: 'bounded',
      semantic: analysisSemanticContract(
        'Assemble bounded compiler, semantic, history, and heuristic context around one explicit target.',
        'A multi-section repository context report with each evidence family kept distinct.',
        [
          'This composite report does not infer task relevance or prove that every returned candidate affects the requested change.',
        ],
      ),
      contrasts: [
        {
          command: 'change-surface',
          distinction:
            'change-surface is the exports/consumers/risk briefing alone; context also includes reference and call relationships, history, and reuse signals.',
        },
      ],
    },
    renderShape: 'custom',
    docs: doc('Exploration', ['scip-query context parseSymbol']),
    handler: handleContext,
  },
];

export function repositoryContextDecisionSections(
  result: queries.RepositoryContextResult,
  target: string,
  limit: number,
  impactDepth: number,
) {
  return [
    { title: 'TARGET', rows: targetRows(result) },
    { title: 'CURRENT RELATIONSHIPS', rows: currentRelationshipRows(result, limit), skipIfEmpty: true },
    { title: 'AFFECTED CONSUMERS', rows: decisionConsumerRows(result, limit), skipIfEmpty: true },
    { title: 'SIMILARITY CANDIDATES', rows: similarityCandidateRows(result, Math.min(limit, 12)), skipIfEmpty: true },
    { title: 'CHANGE CONSTRAINTS', rows: changeConstraintRows(result, limit), skipIfEmpty: true },
    { title: 'RELATED SOURCE IDENTITIES', rows: relatedSourceIdentityRows(result, limit), skipIfEmpty: true },
    { title: 'SOURCE PACKET', rows: sourcePacketRows(result), skipIfEmpty: true },
    {
      title: 'COVERAGE AND RECOVERY',
      rows: decisionCoverageRows(result, target, impactDepth),
    },
  ];
}

function detailedRepositoryContextSections(result: queries.RepositoryContextResult, limit: number) {
  return [
    { title: 'TARGET', rows: targetRows(result) },
    { title: 'DEFINITIONS', rows: definitionRows(result, limit), skipIfEmpty: true },
    { title: 'REFERENCES', rows: referenceRows(result, limit), skipIfEmpty: true },
    { title: 'CALL GRAPH', rows: callGraphRows(result, limit), skipIfEmpty: true },
    { title: 'SIMILARITY CANDIDATES', rows: similarityCandidateRows(result, limit), skipIfEmpty: true },
    { title: 'SOURCE PACKET', rows: sourcePacketRows(result), skipIfEmpty: true },
    { title: 'DEPENDENCIES', rows: dependencyRows(result, limit), skipIfEmpty: true },
    { title: 'SURFACE', rows: surfaceRows(result, limit), skipIfEmpty: true },
    { title: 'DOWNSTREAM IMPACT', rows: affectedRows(result, limit), skipIfEmpty: true },
    { title: 'CHANGE RISK', rows: riskRows(result, limit), skipIfEmpty: true },
    { title: 'HISTORY', rows: historyRows(result), skipIfEmpty: true },
    { title: 'PLANNING NOTES', rows: planningNoteRows(result), skipIfEmpty: true },
  ];
}

function currentRelationshipRows(result: queries.RepositoryContextResult, limit: number): string[] {
  return withOmitted(
    cappedRows([...definitionRows(result, Math.min(limit, 12)), ...callGraphRows(result, limit)], limit),
  );
}

function decisionConsumerRows(result: queries.RepositoryContextResult, limit: number): string[] {
  const direct = result.trace.referencedBy.map(
    (reference) => `  direct  ${reference.relativePath}:${displayLine(reference.line)}  ${reference.enclosingShort}`,
  );
  const downstream = result.affected.map(
    (affected) => `  depth ${affected.depth}  ${affected.file}  ${affected.shortName}`,
  );
  return withOmitted(cappedRows(uniqueRows([...direct, ...downstream]), limit));
}

function changeConstraintRows(result: queries.RepositoryContextResult, limit: number): string[] {
  const rows = [
    ...(result.changeSurface
      ? [
          `  External consumers: ${result.changeSurface.totalExternalConsumers}`,
          `  Changed-file risk factors: ${result.changeSurface.fileRisk?.reasons.length ?? 0}`,
        ]
      : []),
    `  Dependencies: ${result.deps.length}; reverse dependencies: ${result.rdeps.length}`,
    `  Module files: ${result.system.files.length}; exported symbols: ${result.system.symbols.length}; external surface uses: ${result.surface.length}`,
    ...historyRows(result),
    ...planningNoteRows(result),
  ];
  return withOmitted(cappedRows(rows, limit));
}

function relatedSourceIdentityRows(result: queries.RepositoryContextResult, limit: number): string[] {
  const candidates = [
    ...result.trace.definitions.map((definition) => definition.relativePath),
    ...result.trace.referencedBy.map((reference) => reference.relativePath),
    ...(result.callGraph?.callers.map((caller) => caller.file) ?? []),
    ...(result.callGraph?.callees.map((callee) => callee.file) ?? []),
    ...(result.reuseCandidates?.map((candidate) => candidate.fileB) ?? []),
    ...repositoryContextConsumerReuse(result).candidates.map(({ candidate }) => candidate.fileB),
  ];
  return withOmitted(
    cappedRows(
      [...new Set(candidates.filter((file) => file.trim().length > 0))].map((file) => `  ${file}`),
      Math.min(limit, 12),
    ),
  );
}

function decisionCoverageRows(result: queries.RepositoryContextResult, target: string, impactDepth: number): string[] {
  const reuse = repositoryContextConsumerReuse(result).coverage;
  const rows = [
    `  Direct compiler references observed: ${result.trace.referencedBy.length}.`,
    `  Downstream impact is bounded at depth ${impactDepth}.`,
    `  Affected-consumer reuse scan: ${reuse.analyzedConsumers}/${reuse.totalConsumers} analyzed; ${reuse.omittedConsumers} omitted.`,
  ];
  if (result.sourcePacket) {
    rows.push(
      `  Source packet: ${result.sourcePacket.slices.length}/${result.sourcePacket.candidateSlices} slice(s); ${result.sourcePacket.omittedSlices} omitted; at most ${result.sourcePacket.maxSlices} slices, ${result.sourcePacket.maxLinesPerSlice} lines per slice, and ${result.sourcePacket.maxTotalLines} lines total.`,
    );
    if (
      result.sourcePacket.targetLineLimit !== undefined &&
      result.sourcePacket.consumerContextLines !== undefined &&
      result.sourcePacket.reuseLineLimit !== undefined
    ) {
      rows.push(
        `  Source roles: target up to ${result.sourcePacket.targetLineLimit} lines; consumer windows center on each use with ${result.sourcePacket.consumerContextLines} context lines; reuse candidates use up to ${result.sourcePacket.reuseLineLimit} lines.`,
      );
    }
  }
  if (result.warnings.length > 0) rows.push(...result.warnings.map((warning) => `  Warning: ${warning}`));
  rows.push(
    `  Use scip-query refs ${target} --full only when a complete direct-consumer set can change the plan.`,
    `  Use scip-query context ${target} --detail only when this packet leaves a named planning uncertainty.`,
  );
  return rows;
}

function uniqueRows(rows: readonly string[]): string[] {
  return [...new Set(rows)];
}

function repositoryContextCoverage(result: queries.RepositoryContextResult) {
  return {
    complete: false,
    totalKnown: false,
    returned: repositoryContextReturnedUnits(result),
  } as const;
}

function repositoryContextReturnedUnits(result: queries.RepositoryContextResult): number {
  const consumerReuse = repositoryContextConsumerReuse(result);
  return (
    result.trace.definitions.length +
    result.trace.referencedBy.length +
    (result.callGraph?.callers.length ?? 0) +
    (result.callGraph?.callees.length ?? 0) +
    result.affected.length +
    result.deps.length +
    result.rdeps.length +
    result.system.files.length +
    result.system.symbols.length +
    result.system.dependsOn.length +
    result.system.dependedOnBy.length +
    result.surface.length +
    (result.reuseCandidates?.length ?? 0) +
    consumerReuse.coverage.analyzedConsumers +
    consumerReuse.candidates.length +
    (result.sourcePacket?.slices.length ?? 0)
  );
}

function repositoryContextAgentResult(result: queries.RepositoryContextResult) {
  const consumerReuse = repositoryContextConsumerReuse(result);
  return {
    target: result.target,
    matched: result.matched,
    counts: {
      definitions: result.trace.definitions.length,
      references: result.trace.referencedBy.length,
      callers: result.callGraph?.callers.length ?? 0,
      callees: result.callGraph?.callees.length ?? 0,
      affected: result.affected.length,
      dependencies: result.deps.length,
      reverseDependencies: result.rdeps.length,
      moduleFiles: result.system.files.length,
      reuseCandidates: result.reuseCandidates?.length ?? 0,
      affectedConsumersAnalyzed: consumerReuse.coverage.analyzedConsumers,
      consumerReuseCandidates: consumerReuse.candidates.length,
      externalSurfaceUses: result.surface.length,
      coChangePartners: result.history.coChangePartners.length,
      sourceSlices: result.sourcePacket?.slices.length ?? 0,
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
    affectedConsumerReuse: consumerReuse,
  };
}

function similarityCandidateRows(result: queries.RepositoryContextResult, limit: number): string[] {
  const targetRows = (result.reuseCandidates ?? []).flatMap((candidate) => [
    `  target    ${Math.round(candidate.similarity * 100)}%  ${candidate.evidenceClass}  ${candidate.shortNameB}  ${candidate.fileB}`,
    `                    basis=${candidate.similarityBasis ?? 'unknown'}; ${candidate.evidenceClassReasons.join('; ')}`,
  ]);
  const consumerReuse = repositoryContextConsumerReuse(result);
  const consumerRows = consumerReuse.candidates.flatMap(({ candidate, consumers }) => [
    `  consumer  ${Math.round(candidate.similarity * 100)}%  ${candidate.evidenceClass}  ${candidate.shortNameB}  ${candidate.fileB}`,
    `                    basis=${candidate.similarityBasis ?? 'unknown'}; observed from ${consumers.map((consumer) => consumer.shortName).join(', ')}; ${candidate.evidenceClassReasons.join('; ')}`,
  ]);
  const coverage = consumerReuse.coverage;
  const coverageRows =
    coverage.totalConsumers > 0
      ? [
          `  Affected-consumer scan: ${coverage.analyzedConsumers}/${coverage.totalConsumers} compiler-resolved consumer(s) analyzed; ${coverage.omittedConsumers} omitted; first ${coverage.perConsumerSearchLimit} similarity result(s) checked and up to ${coverage.perConsumerCandidateLimit} usable option(s) kept per consumer.`,
        ]
      : [];
  const rows = [...targetRows, ...coverageRows, ...consumerRows];
  return withOmitted(cappedRows(rows, limit));
}

function targetRows(result: queries.RepositoryContextResult): string[] {
  const rows = [
    `Target: ${result.target}`,
    `Matched: symbol=${yesNo(result.matched.symbol)} file=${yesNo(result.matched.file)} module=${yesNo(result.matched.module)}`,
  ];
  if (result.primaryCallable) {
    rows.push(`Primary callable: ${result.primaryCallable.shortName}  ${result.primaryCallable.file}`);
  }
  return rows;
}

function sourcePacketRows(result: queries.RepositoryContextResult): string[] {
  if (!result.sourcePacket || result.sourcePacket.slices.length === 0) return [];
  const rows: string[] = [];
  for (const slice of result.sourcePacket.slices) {
    rows.push(
      `  ${slice.role.padEnd(15)} ${displayPathRange(slice.file, slice.startLine, slice.endLine)}  ${slice.shortName}`,
    );
    rows.push(
      ...slice.source.split('\n').map((line, index) => {
        const sourceLine = slice.startLine + index;
        const marker = slice.focusLines?.includes(sourceLine) ? '>' : ' ';
        return `   ${marker}${String(displayLine(sourceLine)).padStart(4)}  ${line}`;
      }),
    );
    if (slice.omittedLines > 0) rows.push(`    ... ${slice.omittedLines} more line(s) in this callable`);
  }
  if (result.sourcePacket.omittedSlices > 0) {
    rows.push(`  ... ${result.sourcePacket.omittedSlices} more candidate slice(s)`);
  }
  return rows;
}

function definitionRows(result: queries.RepositoryContextResult, limit: number): string[] {
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

function referenceRows(result: queries.RepositoryContextResult, limit: number): string[] {
  const rows = result.trace.referencedBy.map(
    (ref) => `  ${ref.relativePath}:${displayLine(ref.line)}  in ${ref.enclosingShort}`,
  );
  return withOmitted(cappedRows(rows, limit));
}

function callGraphRows(result: queries.RepositoryContextResult, limit: number): string[] {
  if (!result.callGraph) return [];
  const callerRows = result.callGraph.callers.map((caller) => `  caller  ${caller.file}  ${caller.shortName}`);
  const calleeRows = result.callGraph.callees.map((callee) => `  callee  ${callee.file}  ${callee.shortName}`);
  return withOmitted(cappedRows([...callerRows, ...calleeRows], limit));
}

function dependencyRows(result: queries.RepositoryContextResult, limit: number): string[] {
  const rows = [
    ...result.deps.map((dep) => `  file depends on      ${dep.relativePath}`),
    ...result.rdeps.map((dep) => `  file depended on by  ${dep.relativePath}`),
    ...result.system.dependsOn.map((dep) => `  module depends on    ${dep}`),
    ...result.system.dependedOnBy.map((dep) => `  module used by       ${dep}`),
  ];
  return withOmitted(cappedRows(rows, limit));
}

function surfaceRows(result: queries.RepositoryContextResult, limit: number): string[] {
  const rows = [
    ...result.system.files.map((file) => `  file    ${file}`),
    ...result.system.symbols.map(
      (symbol) => `  export  ${displayRange(symbol.startLine, symbol.endLine)}  ${symbol.shortName}`,
    ),
    ...result.surface.map((surface) => `  use     ${surface.consumer} -> ${surface.shortName}`),
  ];
  return withOmitted(cappedRows(rows, limit));
}

function affectedRows(result: queries.RepositoryContextResult, limit: number): string[] {
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

function riskRows(result: queries.RepositoryContextResult, limit: number): string[] {
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
    rows.push(`  Metric rules: ${result.complexity.metricRules}`);
    rows.push(`  Callees: ${result.complexity.calleeCount}`);
    rows.push(`  Candidate targets: ${result.complexity.candidateCalleeCount}`);
    rows.push(`  Fan-in: ${result.complexity.fanIn}`);
    rows.push(`  Fan-out: ${result.complexity.fanOut}`);
  }
  return withOmitted(cappedRows(rows, limit));
}

function historyRows(result: queries.RepositoryContextResult): string[] {
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

function planningNoteRows(result: queries.RepositoryContextResult): string[] {
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
  if (result.reuseCandidates?.some((candidate) => candidate.actionTier === 'direct')) {
    rows.push(
      '  A direct reuse option requires a responsibility and behavior comparison. Reuse the existing owner when they match. Current wiring or reachability alone does not justify separate ownership; rejection needs a concrete behavioral or boundary difference.',
    );
  }
  if (repositoryContextConsumerReuse(result).candidates.length > 0) {
    rows.push(
      '  An affected-consumer reuse option can own surrounding behavior that target-only comparison cannot see. Compare each direct option before editing, and keep duplicate ownership only for a concrete behavioral or boundary difference.',
    );
  }
  return rows;
}

function repositoryContextConsumerReuse(
  result: queries.RepositoryContextResult,
): queries.RepositoryContextConsumerReuse {
  return (
    result.affectedConsumerReuse ?? {
      candidates: [],
      coverage: {
        totalConsumers: 0,
        analyzedConsumers: 0,
        omittedConsumers: 0,
        perConsumerSearchLimit: 0,
        perConsumerCandidateLimit: 0,
        candidateLimit: 0,
        returnedCandidates: 0,
      },
    }
  );
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
