import * as queries from '../../queries/index.js';
import { REPOSITORY_OBSERVATION_OPERATION } from '../command-operation.js';
import type { CommandDescriptor, InvocationCoverage } from '../command-kit/command-descriptor-types.js';
import {
  agentContract,
  collectValues,
  compactOption,
  doc,
  option,
  parseInteger,
  parseNonNegativeInteger,
  parsePositiveInteger,
  withJsonOption,
} from '../command-kit/command-spec-builders.js';
import {
  booleanOptionValue,
  budgetedDbCommand,
  budgetedListCommand,
  dbCommand,
  definedLimitOption,
  definedNumberOption,
  printJsonEnvelope,
  stringArg,
  stringArrayOptionValue,
  stringOptionValue,
} from '../command-kit/command-execution.js';
import {
  budgetedSectionedQueryCommand,
  listQueryCommand,
  sectionedQueryCommand,
  tableQueryCommand,
} from '../command-kit/query-command-builders.js';
import { displayLine, displayPathRange, displayRange, render } from '../render.js';
import type { ReportSection } from '../render.js';
import {
  symbolResolutionJson,
  symbolResolutionBefore,
  symbolResolutionEmptyMessage,
  withSymbolResolutionJson,
} from './symbol-resolution.js';
import { directNavigationQueryCommandDescriptors } from './direct-navigation.js';

function traceSections(result: ReturnType<typeof queries.traceEvidence>): ReportSection[] {
  const definitionRows: string[] = [];
  for (const d of result.definitions) {
    const sig = d.signature ? `  — ${d.signature}` : '';
    definitionRows.push(`  ${displayPathRange(d.relativePath, d.startLine, d.endLine)}${sig}`);
    if (d.source) {
      definitionRows.push(
        d.source
          .split('\n')
          .map((line, index) => `    ${displayLine(d.startLine + index)}  ${line}`)
          .join('\n'),
      );
    }
  }

  const refRows: string[] = [];
  let prevFile = '';
  for (const ref of result.referencedBy) {
    if (ref.relativePath !== prevFile) {
      if (prevFile) refRows.push('');
      refRows.push(`  ${ref.relativePath}`);
      prevFile = ref.relativePath;
    }
    refRows.push(`    line ${displayLine(ref.line)}  in ${ref.enclosingShort}`);
    if (
      ref.source !== undefined &&
      ref.source !== null &&
      ref.sourceStartLine !== undefined &&
      ref.sourceStartLine !== null
    ) {
      refRows.push(renderSourceLines(ref.source, ref.sourceStartLine, new Set([ref.line]), '      '));
    }
  }

  return [
    { title: 'DEFINITION', rows: definitionRows },
    { title: 'REFERENCED BY', rows: refRows },
  ];
}

const EVIDENCE_PARTS = [
  'definition',
  'references',
  'callers',
  'callees',
  'dependencies',
  'consumers',
] as const satisfies readonly queries.EvidencePart[];

function selectedEvidenceParts(values: readonly string[]): queries.EvidencePart[] | undefined {
  if (values.length === 0) return undefined;
  const expanded = values
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  if (expanded.includes('all')) return [...EVIDENCE_PARTS];
  const invalid = expanded.filter((value) => !EVIDENCE_PARTS.includes(value as queries.EvidencePart));
  if (invalid.length > 0) {
    throw new Error(`Unknown evidence part: ${invalid.join(', ')}. Use ${EVIDENCE_PARTS.join(', ')}, or all.`);
  }
  return [...new Set(expanded as queries.EvidencePart[])];
}

function renderSourceLines(
  source: string,
  startLine: number,
  focusLines: ReadonlySet<number>,
  indent = '    ',
): string {
  return source
    .split('\n')
    .map((line, index) => {
      const sourceLine = startLine + index;
      const marker = focusLines.has(sourceLine) ? '>' : ' ';
      return `${indent}${marker}${String(displayLine(sourceLine)).padStart(5)}  ${line}`;
    })
    .join('\n');
}

function sourceSearchSections(result: queries.SourceSearchResult): ReportSection[] {
  const rows = result.matches.map((match) => {
    const owner = match.ownerShort ? `  in ${match.ownerShort}` : '';
    return [
      `  ${displayPathRange(match.relativePath, match.startLine, match.endLine)}${owner}`,
      renderSourceLines(match.source, match.startLine, new Set([match.focusLine]), '    '),
    ].join('\n');
  });
  if (result.omittedMatches > 0) rows.push(`  ... ${result.omittedMatches} more matching line(s); increase --limit.`);
  return [{ title: 'SOURCE MATCHES', rows }];
}

function sourceInspectionSections(result: queries.SourceInspectionResult): ReportSection[] {
  const searchRows = result.searches.map(
    (search) =>
      `  ${search.pattern}: ${search.returnedMatches}/${search.matchingLines} matching line(s) selected` +
      (search.omittedMatches > 0 ? `; ${search.omittedMatches} omitted` : ''),
  );
  const locationRows = result.locations.map(
    (location) => `  ${location.matched ? 'matched' : 'missing'}  ${location.target}`,
  );
  const sourceRows = result.slices.map((slice) => {
    const owner = slice.ownerShort ? `  in ${slice.ownerShort}` : '';
    const omitted = slice.omittedLines > 0 ? `  (${slice.omittedLines} line(s) omitted)` : '';
    return [
      `  ${displayPathRange(slice.relativePath, slice.startLine, slice.endLine)}${owner}${omitted}`,
      `    selected by ${slice.reasons.join(', ')}`,
      renderSourceLines(slice.source, slice.startLine, new Set(slice.focusLines), '    '),
    ].join('\n');
  });
  const evidence = result.evidence.flatMap((item, index) => {
    const failure = evidenceFailureMessage(item, 'inspect');
    if (failure) return [{ title: `EVIDENCE ${index + 1}`, rows: [`  ${failure}`] }];
    return evidenceSections(item).map((section) => ({
      ...section,
      title: `EVIDENCE ${index + 1} · ${section.title}`,
    }));
  });
  return [
    { title: 'SEARCH COVERAGE', rows: searchRows, skipIfEmpty: true },
    { title: 'LOCATION COVERAGE', rows: locationRows, skipIfEmpty: true },
    { title: 'RELATED SOURCE', rows: sourceRows, skipIfEmpty: true },
    ...evidence,
    {
      title: 'PACKET COVERAGE',
      rows: [
        `  Search/location source: ${result.slices.length}/${result.candidateSlices} candidate slice(s) returned; ${result.omittedSlices} omitted.`,
        `  Symbol evidence: ${sourceInspectionEvidenceUnits(result)} returned unit(s) from ${result.evidence.length} selector(s).`,
        `  Search/location limits: ${result.maxSlices} slices and ${result.maxTotalLines} source lines.`,
      ],
    },
  ];
}

function sourceInspectionEvidenceUnits(result: queries.SourceInspectionResult): number {
  return result.evidence.reduce((total, item) => {
    if (item.kind !== 'matched') return total + 1;
    return (
      total +
      (item.definition ? 1 : 0) +
      item.referenceWindows.length +
      item.callers.length +
      item.callees.length +
      item.dependencies.length +
      item.consumers.length
    );
  }, 0);
}

function evidenceFailureMessage(
  result: queries.EvidenceResult,
  command: 'evidence' | 'inspect' = 'evidence',
): string | undefined {
  if (result.kind === 'missing') return `No definition matched '${result.query}'.`;
  if (result.kind !== 'ambiguous') return undefined;
  const commands = result.candidates
    .map((candidate) => {
      const target = `'${candidate.symbol.replaceAll("'", "'\\''")}'`;
      return command === 'inspect' ? `  scip-query inspect --symbol ${target}` : `  scip-query evidence ${target}`;
    })
    .join('\n');
  const shown = result.candidates.length;
  const coverage = shown < result.total ? ` Showing the highest-ranked ${shown}; narrow by path or` : '';
  return (
    `Target '${result.query}' is ambiguous across ${result.total} definitions.${coverage} ` +
    `run one listed exact command:\n${commands}`
  );
}

function evidenceSections(result: queries.EvidenceResult): ReportSection[] {
  if (result.kind !== 'matched') return [];
  const definitionRows = result.definition
    ? [
        `  ${displayPathRange(result.definition.relativePath, result.definition.startLine, result.definition.endLine)}  ${result.definition.shortName}`,
        renderSourceLines(result.definition.source, result.definition.startLine, new Set(), '    '),
      ]
    : [];
  const referenceRows = result.referenceWindows.map((window) => {
    const identities = window.references
      .map((reference) => `${displayLine(reference.line)} in ${reference.enclosingShort}`)
      .join(', ');
    return [
      `  ${displayPathRange(window.relativePath, window.startLine, window.endLine)}  references: ${identities}`,
      renderSourceLines(
        window.source,
        window.startLine,
        new Set(window.references.map((reference) => reference.line)),
        '    ',
      ),
    ].join('\n');
  });
  const relatedRows = (rows: readonly queries.EvidenceRelatedSymbol[]) =>
    rows.map((row) =>
      [
        `  ${displayPathRange(row.relativePath, row.startLine, row.endLine)}  ${row.shortName}${row.omittedLines > 0 ? `  (${row.omittedLines} line(s) omitted)` : ''}`,
        renderSourceLines(row.source, row.startLine, new Set(), '    '),
      ].join('\n'),
    );
  return [
    { title: 'DEFINITION', rows: definitionRows, skipIfEmpty: true },
    { title: 'REFERENCE SITES', rows: referenceRows, skipIfEmpty: true },
    { title: 'CALLERS', rows: relatedRows(result.callers), skipIfEmpty: true },
    { title: 'CALLEES', rows: relatedRows(result.callees), skipIfEmpty: true },
    { title: 'DEPENDENCIES', rows: result.dependencies.map((row) => `  ${row.relativePath}`), skipIfEmpty: true },
    { title: 'CONSUMERS', rows: result.consumers.map((row) => `  ${row.relativePath}`), skipIfEmpty: true },
  ];
}

const handleImports = budgetedListCommand('imports', {
  query: ({ db, args, budget }) => queries.imports(db, stringArg(args, 0), { semantic: budget.semantic }),
  format: (r) => `  ${r.shortName}  ← ${r.fromFile}`,
  emptyMessage: () => 'No imports found (indexer may not emit role=2 for this language).',
});

const handleDataflow = budgetedDbCommand('dataflow', ({ db, args, opts, budget }) => {
  const query = stringArg(args, 0);
  const result = queries.dataflow(db, query, { semantic: budget.semantic });
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('dataflow', args, opts, withSymbolResolutionJson(db, query, result, 'dataflow'), {
      analysisBudget: budget.analysisBudget,
    });
    return;
  }
  if (!result) return render.empty(symbolResolutionEmptyMessage(db, query, 'No dataflow found.'));
  symbolResolutionBefore(db, query);
  console.log(`${result.shortName}  (${result.relativePath})\n`);
  if (result.definitionSites.length > 0) {
    console.log('  ═══ DEFINED AT ═══');
    for (const s of result.definitionSites) console.log(`    ${s.file}:${displayLine(s.line)}`);
  }
  if (result.usageSites.length > 0) {
    console.log('\n  ═══ USED AT ═══');
    for (const s of result.usageSites) console.log(`    ${s.file}:${displayLine(s.line)}  in ${s.enclosingShort}`);
  }
  if (result.producers.length > 0) {
    console.log('\n  ═══ PRODUCERS (feeds into this) ═══');
    for (const p of result.producers) console.log(`    ${p.file}  ${p.shortName}`);
  }
  if (result.consumers.length > 0) {
    console.log('\n  ═══ CONSUMERS (this feeds into) ═══');
    for (const c of result.consumers) console.log(`    ${c.file}  ${c.shortName}`);
  }
});

const handleSlice = budgetedDbCommand('slice', ({ db, args, opts, budget }) => {
  const query = stringArg(args, 0);
  const direction = booleanOptionValue(opts, 'forward') ? 'forward' : 'backward';
  const result = queries.slice(db, query, {
    direction,
    maxDepth: definedNumberOption(opts, 'depth', 3),
    semantic: budget.semantic,
  });
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('slice', args, opts, withSymbolResolutionJson(db, query, result, 'slice'), {
      analysisBudget: budget.analysisBudget,
    });
    return;
  }
  if (!result) return render.empty(symbolResolutionEmptyMessage(db, query, 'No slice found.'));
  symbolResolutionBefore(db, query);
  console.log(`${result.direction} slice of ${result.shortName}\n`);
  if (result.connectedSymbols.length === 0) {
    console.log('  No connected symbols found.');
    return;
  }
  render.list(result.connectedSymbols, (s) => `  ${s.file}  ${s.shortName}\n    ${s.relationship}`);
  console.log(`\n${result.connectedSymbols.length} connected symbol(s).`);
});

const handleMethods = dbCommand(({ db, args, opts }) => {
  const className = stringArg(args, 0);
  const result = queries.resolveMethods(db, { className });
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('methods', args, opts, result, {
      coverage: methodsInvocationCoverage(result),
    });
    if (result.kind !== 'matched') process.exitCode = 1;
    return;
  }
  if (result.kind === 'matched') {
    render.list(result.methods, (method) => `  ${displayRange(method.startLine, method.endLine)}  ${method.name}`);
    return;
  }
  render.empty(methodsResolutionFailureMessage(result));
  process.exitCode = 1;
});

function methodsInvocationCoverage(result: queries.MethodsResolution): InvocationCoverage {
  const returned = result.kind === 'matched' ? result.methods.length : 0;
  const resolution: NonNullable<InvocationCoverage['resolution']> =
    result.kind === 'matched'
      ? { state: 'exact', totalCandidates: 1 }
      : result.kind === 'missing'
        ? { state: 'missing', totalCandidates: 0 }
        : { state: 'ambiguous', totalCandidates: result.total };
  return {
    complete: true,
    totalKnown: true,
    returned,
    total: returned,
    omitted: 0,
    resolution,
  };
}

function methodsResolutionFailureMessage(result: Exclude<queries.MethodsResolution, { kind: 'matched' }>): string {
  if (result.kind === 'missing') {
    const base = `No class definition matched '${result.query}'.`;
    return result.suggestions.length > 0 ? `${base} Suggestions: ${result.suggestions.join(', ')}` : base;
  }
  const candidates = result.candidates
    .map((candidate) => `${candidate.relativePath}:${displayLine(candidate.startLine)}`)
    .join(', ');
  return (
    `Class '${result.query}' is ambiguous across ${result.total} definitions (${candidates}). ` +
    'Qualify it with a path or exact SCIP symbol identity.'
  );
}

export const navigationQueryCommandDescriptors: CommandDescriptor[] = [
  ...directNavigationQueryCommandDescriptors,
  listQueryCommand({
    id: 'files',
    command: 'files <pattern>',
    description: 'Find files matching a pattern',
    agent: agentContract(
      'Which indexed files match this text pattern?',
      'matching file paths',
      ['pattern'],
      'complete',
    ),
    docs: doc('Navigation', ['scip-query files auth']),
    query: ({ db, args }) => queries.files(db, stringArg(args, 0)),
    format: (r) => r.relativePath,
  }),
  budgetedSectionedQueryCommand({
    id: 'inspect',
    command: 'inspect',
    description: 'Batch related searches, symbols, and source locations into one deduplicated source packet',
    options: [
      option('--search <text>', 'Find this literal text; repeat for related anchors', collectValues, []),
      option(
        '--symbol <symbol>',
        'Add definition and use evidence for this symbol; repeat for related owners',
        collectValues,
        [],
      ),
      option(
        '--at <file:line>',
        'Add the smallest readable source unit around this location; repeat as needed',
        collectValues,
        [],
      ),
      option('-s, --scope <path>', 'Limit literal searches to indexed paths matching this text'),
      option('-C, --context <n>', 'Fallback lines around a match with no syntax unit', parseNonNegativeInteger, 6),
      option('-n, --limit <n>', 'Maximum matching lines selected per search', parsePositiveInteger, 6),
      option('--unit-lines <n>', 'Maximum lines for each syntax-aware source unit', parsePositiveInteger, 80),
      option('--total-lines <n>', 'Maximum source lines across the search/location packet', parsePositiveInteger, 300),
      option(
        '--include <part>',
        'Add definition, references, callers, callees, dependencies, consumers, or all to every symbol; repeat or comma-separate',
        collectValues,
        [],
      ),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ],
    budget: 'semantic',
    agent: agentContract(
      'Which related source units across several known text, symbol, or location anchors should be read together?',
      'one bounded, deduplicated source packet plus selected symbol relationships and coverage',
      [],
      'bounded',
      'repository',
    ),
    docs: doc('Navigation', [
      "scip-query inspect --search sessionStreamEvents --search work_session_stream_events --search 'agent:work_session'",
      'scip-query inspect --symbol appendEvent --symbol publishEvent --include definition,references,callers,callees',
      'scip-query inspect --at src/api.ts:42 --at src/web.tsx:90',
    ]),
    query: ({ db, opts, budget }) =>
      queries.inspectSource(db, {
        searches: stringArrayOptionValue(opts, 'search'),
        symbols: stringArrayOptionValue(opts, 'symbol'),
        locations: stringArrayOptionValue(opts, 'at'),
        scope: stringOptionValue(opts, 'scope'),
        context: definedNumberOption(opts, 'context', 6),
        searchLimit: definedLimitOption(opts, 'limit', 6),
        unitLines: definedNumberOption(opts, 'unitLines', 80),
        totalLines: definedNumberOption(opts, 'totalLines', 300),
        evidence: {
          parts: selectedEvidenceParts(stringArrayOptionValue(opts, 'include')),
          referenceContext: 4,
          relatedSourceLines: 60,
          semantic: budget.semantic,
        },
      }),
    coverage: (result, { budget }) => {
      const omittedMatches = result.searches.reduce((total, search) => total + search.omittedMatches, 0);
      const omitted = omittedMatches + result.omittedSlices;
      const returned = result.slices.length + sourceInspectionEvidenceUnits(result);
      return budget.analysisBudget || omitted > 0
        ? { complete: false, totalKnown: false, returned }
        : {
            complete: true,
            totalKnown: true,
            returned,
            total: returned,
            omitted: 0,
          };
    },
    agentResult: (result) => ({
      searches: result.searches,
      evidence: result.evidence.map((item) => ({ query: item.query, kind: item.kind })),
      locations: result.locations,
      returnedSlices: result.slices.length,
      returnedEvidenceUnits: sourceInspectionEvidenceUnits(result),
      omittedSlices: result.omittedSlices,
    }),
    sections: sourceInspectionSections,
  }),
  sectionedQueryCommand({
    id: 'search',
    command: 'search <text>',
    description: 'Search literal or regular-expression text in indexed source with nearby code and symbol ownership',
    options: [
      option('-s, --scope <path>', 'Limit the search to indexed paths matching this text'),
      option('-C, --context <n>', 'Source lines before and after each match', parseNonNegativeInteger, 6),
      option('-n, --limit <n>', 'Maximum matching lines to return', parsePositiveInteger, 12),
      option('--full', 'Return every matching line'),
      option('--regexp', 'Treat the search text as a bounded regular expression'),
      option('-i, --ignore-case', 'Ignore case'),
    ],
    agent: agentContract(
      'Where does this exact text occur in indexed source, and which symbol owns each line?',
      'matching source windows, file and line identities, owning symbols, and coverage',
      ['pattern'],
      'bounded',
    ),
    docs: doc('Navigation', ["scip-query search 'eventName'", "scip-query search 'send.*event' --regexp --scope src"]),
    query: ({ db, args, opts }) =>
      queries.searchSource(db, stringArg(args, 0), {
        scope: stringOptionValue(opts, 'scope'),
        context: definedNumberOption(opts, 'context', 6),
        limit: definedLimitOption(opts, 'limit', 12),
        regexp: booleanOptionValue(opts, 'regexp'),
        ignoreCase: booleanOptionValue(opts, 'ignoreCase'),
      }),
    emptyMessage: (result) =>
      result.matchingLines === 0 ? `No indexed source line matched '${result.pattern}'.` : undefined,
    coverage: (result) =>
      result.omittedMatches === 0
        ? {
            complete: true,
            totalKnown: true,
            returned: result.matches.length,
            total: result.matchingLines,
            omitted: 0,
          }
        : {
            complete: false,
            totalKnown: true,
            returned: result.matches.length,
            total: result.matchingLines,
            omitted: result.omittedMatches,
          },
    agentResult: (result) => ({
      mode: result.mode,
      scannedFiles: result.scannedFiles,
      returnedMatches: result.matches.length,
      totalMatches: result.matchingLines,
      omittedMatches: result.omittedMatches,
      matchIdentities: result.matches.map((match) => `${match.relativePath}:${displayLine(match.focusLine)}`),
    }),
    sections: sourceSearchSections,
  }),
  {
    id: 'methods',
    command: 'methods <className>',
    description: 'List methods of one exactly resolved class; ambiguity and missing targets fail explicitly',
    options: withJsonOption(),
    agent: {
      ...agentContract('Which methods belong to this class?', 'method names and line ranges', ['symbol'], 'complete'),
      resultUnits: { kind: 'field', field: 'methods' },
    },
    docs: doc('Navigation'),
    renderShape: 'list',
    handler: handleMethods,
  },
  budgetedSectionedQueryCommand({
    id: 'trace',
    command: 'trace <symbol>',
    description: 'Trace a symbol: definition + all references',
    options: [option('--full', 'Run unbounded semantic analysis on large indexes'), compactOption()],
    budget: 'semantic',
    agent: {
      operation: REPOSITORY_OBSERVATION_OPERATION,
      answers: ['Where is this symbol defined, and everywhere is it referenced?'],
      returns: ['definition sites with source and signature', 'referencing files with line numbers'],
      inputs: ['symbol'],
      coverage: 'bounded',
      contrasts: [
        {
          command: 'refs',
          distinction: 'refs returns reference sites only; trace adds the definition and its source.',
        },
        {
          command: 'call-graph',
          distinction: 'trace lists reference sites flat; call-graph separates incoming callers from outgoing callees.',
        },
      ],
    },
    docs: doc('Navigation', ['scip-query trace parseSymbol']),
    query: ({ db, args, budget }) => queries.traceEvidence(db, stringArg(args, 0), { semantic: budget.semantic }),
    emptyMessage: (result, { db, args }) =>
      result.definitions.length === 0 && result.referencedBy.length === 0
        ? symbolResolutionEmptyMessage(db, stringArg(args, 0), 'No trace rows found.')
        : undefined,
    before: (_result, { db, args }) => symbolResolutionBefore(db, stringArg(args, 0)),
    toJson: (result, { db, args }) => ({ ...symbolResolutionJson(db, stringArg(args, 0)), ...result }),
    coverage: (result, { budget }) => {
      const returned = result.definitions.length + result.referencedBy.length;
      return budget.analysisBudget
        ? { complete: false, totalKnown: false, returned }
        : { complete: true, totalKnown: true, returned, total: returned, omitted: 0 };
    },
    agentResult: (result) => ({
      definitionCount: result.definitions.length,
      referenceCount: result.referencedBy.length,
      definitionIdentities: result.definitions.map(
        (definition) => `${definition.relativePath}:${definition.startLine}-${definition.endLine}`,
      ),
      referenceIdentities: result.referencedBy.map((reference) => `${reference.relativePath}:${reference.line}`),
    }),
    sections: traceSections,
  }),
  budgetedSectionedQueryCommand({
    id: 'evidence',
    command: 'evidence <symbol>',
    description: 'Compose related source for one exact symbol in a single evidence view',
    options: [
      option(
        '--include <part>',
        'Add definition, references, callers, callees, dependencies, consumers, or all; repeat or comma-separate',
        collectValues,
        [],
      ),
      option('-C, --context <n>', 'Source lines before and after each reference', parseNonNegativeInteger, 2),
      option('--related-source-lines <n>', 'Maximum source lines for each caller or callee', parsePositiveInteger, 80),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ],
    budget: 'semantic',
    agent: {
      operation: REPOSITORY_OBSERVATION_OPERATION,
      answers: [
        'Where is this exact symbol defined, and what source uses it?',
        'Which related callers, callees, dependencies, or consumers must be read together?',
      ],
      returns: [
        'definition source',
        'deduplicated reference-centered source windows',
        'selected related symbol source and file relationships',
        'explicit ambiguity failure with exact rerun commands',
      ],
      inputs: ['symbol'],
      coverage: 'bounded',
    },
    docs: doc('Navigation', [
      'scip-query evidence appendEvent',
      'scip-query evidence appendEvent --include definition,references,callers,callees',
    ]),
    query: ({ db, args, opts, budget }) =>
      queries.evidence(db, stringArg(args, 0), {
        parts: selectedEvidenceParts(stringArrayOptionValue(opts, 'include')),
        referenceContext: definedNumberOption(opts, 'context', 2),
        relatedSourceLines: definedNumberOption(opts, 'relatedSourceLines', 80),
        semantic: budget.semantic,
      }),
    emptyMessage: (result) => evidenceFailureMessage(result),
    before: (result) => {
      if (result.kind !== 'matched') process.exitCode = 1;
    },
    coverage: (result, { budget }) => {
      if (result.kind !== 'matched') return { complete: true, totalKnown: true, returned: 0, total: 0, omitted: 0 };
      const returned =
        (result.definition ? 1 : 0) +
        result.referenceWindows.reduce((total, window) => total + window.references.length, 0) +
        result.callers.length +
        result.callees.length +
        result.dependencies.length +
        result.consumers.length;
      return budget.analysisBudget
        ? { complete: false, totalKnown: false, returned }
        : { complete: true, totalKnown: true, returned, total: returned, omitted: 0 };
    },
    agentResult: (result) =>
      result.kind === 'matched'
        ? {
            symbol: result.symbol,
            file: result.file,
            parts: result.parts,
            referenceSites: result.referenceWindows.reduce((total, window) => total + window.references.length, 0),
            sourceWindows: result.referenceWindows.length,
            callers: result.callers.length,
            callees: result.callees.length,
            dependencies: result.dependencies.length,
            consumers: result.consumers.length,
          }
        : result,
    sections: evidenceSections,
  }),
  listQueryCommand({
    id: 'deps',
    command: 'deps <file>',
    description: 'Files this file depends on (internal)',
    agent: agentContract(
      'Which internal files does this file depend on?',
      'dependency file paths',
      ['file'],
      'complete',
    ),
    docs: doc('Navigation'),
    query: ({ db, args }) => queries.deps(db, stringArg(args, 0)),
    format: (r) => r.relativePath,
  }),
  listQueryCommand({
    id: 'rdeps',
    command: 'rdeps <file>',
    description: 'Files that depend on this file/module',
    agent: agentContract(
      'Which internal files depend on this file?',
      'reverse-dependency file paths',
      ['file'],
      'complete',
    ),
    docs: doc('Navigation'),
    query: ({ db, args }) => queries.rdeps(db, stringArg(args, 0)),
    format: (r) => r.relativePath,
  }),
  sectionedQueryCommand({
    id: 'system',
    command: 'system <module>',
    description: 'Full module map: files, symbols, deps in/out',
    options: [compactOption()],
    agent: {
      operation: REPOSITORY_OBSERVATION_OPERATION,
      answers: ['What is in this module?', 'What does this module depend on, and what depends on it?'],
      returns: [
        'module file paths',
        'exported symbols with line ranges',
        'internal dependencies',
        'reverse dependencies',
      ],
      inputs: ['module'],
      // No budget and no row cap: every section is the whole set.
      coverage: 'complete',
      contrasts: [
        {
          command: 'surface',
          distinction: 'system lists everything the module exports; surface lists only what consumers actually use.',
        },
        { command: 'outline', distinction: 'system is module-scoped; outline covers a single file.' },
      ],
    },
    docs: doc('Navigation', ['scip-query system queries']),
    query: ({ db, args }) => queries.system(db, stringArg(args, 0)),
    coverage: (result) => {
      const returned =
        result.files.length + result.symbols.length + result.dependsOn.length + result.dependedOnBy.length;
      return { complete: true, totalKnown: true, returned, total: returned, omitted: 0 };
    },
    agentResult: (result) => ({
      counts: {
        files: result.files.length,
        symbols: result.symbols.length,
        dependencies: result.dependsOn.length,
        consumers: result.dependedOnBy.length,
      },
      files: result.files,
      dependsOn: result.dependsOn,
      dependedOnBy: result.dependedOnBy,
      detail: {
        location: 'result',
        symbolUnits: 'result.symbols contains every exported symbol with its line range',
      },
    }),
    sections: (result) => [
      { title: 'FILES', rows: result.files },
      {
        title: 'EXPORTED SYMBOLS',
        rows: result.symbols.map((s) => `  ${displayRange(s.startLine, s.endLine)}  ${s.shortName}`),
      },
      { title: 'DEPENDS ON (internal)', rows: result.dependsOn.map((d) => `  ${d}`) },
      { title: 'DEPENDED ON BY', rows: result.dependedOnBy.map((d) => `  ${d}`) },
    ],
  }),
  listQueryCommand({
    id: 'surface',
    command: 'surface <module>',
    description: 'What symbols consumers actually use from this module',
    agent: agentContract(
      'Which exported symbols do external consumers actually use?',
      'consumer paths and consumed symbol identities',
      ['module'],
      'complete',
    ),
    docs: doc('Navigation'),
    query: ({ db, args }) => queries.surface(db, stringArg(args, 0)),
    format: (r) => `  ${r.consumer} → ${r.shortName}`,
  }),
  {
    id: 'imports',
    command: 'imports <file>',
    description: 'What symbols does this file import?',
    agent: agentContract(
      'Which symbols does this file import?',
      'imported symbol identities and source files',
      ['file'],
      'bounded',
    ),
    options: withJsonOption([option('--full', 'Run unbounded semantic analysis on large indexes')]),
    budget: 'semantic',
    renderShape: 'list',
    docs: doc('Navigation'),
    handler: handleImports,
  },
  listQueryCommand({
    id: 'imported-by',
    command: 'imported-by <symbol>',
    description: 'Which files import this symbol?',
    agent: agentContract('Which files import this symbol?', 'importing file paths', ['symbol'], 'complete'),
    docs: doc('Navigation'),
    query: ({ db, args }) => queries.importedBy(db, stringArg(args, 0)),
    format: (r) => `  ${r.fromFile}`,
  }),
  listQueryCommand({
    id: 'members',
    command: 'members <symbol>',
    description: 'All children of a symbol (methods, fields, nested types)',
    agent: agentContract(
      'Which members or nested symbols belong to this symbol?',
      'child symbol identities, kinds, and ranges',
      ['symbol'],
      'complete',
    ),
    docs: doc('Navigation'),
    query: ({ db, args }) => queries.members(db, stringArg(args, 0)),
    format: (r) => `  ${displayRange(r.startLine, r.endLine)}  [${r.kind}]  ${r.shortName}`,
    before: (_rows, { db, args }) => symbolResolutionBefore(db, stringArg(args, 0)),
    emptyMessage: ({ db, args }) => symbolResolutionEmptyMessage(db, stringArg(args, 0), 'No child symbols found.'),
    toJson: (rows, { db, args }) => withSymbolResolutionJson(db, stringArg(args, 0), rows, 'members'),
  }),
  listQueryCommand({
    id: 'by-kind',
    command: 'by-kind <kind>',
    description: 'Find symbols by SCIP kind (class, interface, enum, function, etc.)',
    agent: agentContract(
      'Which symbols have this SCIP kind?',
      'symbol identities, kinds, files, and ranges',
      ['pattern'],
      'bounded',
    ),
    options: [
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('-n, --limit <n>', 'Number of results', parseInteger, 100),
      option('--full', 'Run unbounded analysis on large indexes'),
    ],
    docs: doc('Navigation'),
    query: ({ db, args, opts }) =>
      queries.byKind(db, stringArg(args, 0), {
        scope: stringOptionValue(opts, 'scope'),
        limit: definedLimitOption(opts, 'limit', 100),
      }),
    format: (r) => `  ${displayPathRange(r.relativePath, r.startLine, r.endLine)}  [${r.kindName}]  ${r.shortName}`,
    emptyMessage: ({ args }) =>
      `No symbols found for kind "${stringArg(args, 0)}". Use "kind-counts" to see available kinds.`,
    after: (rows) => console.log(`\n${rows.length} symbol(s)`),
  }),
  tableQueryCommand({
    id: 'kind-counts',
    command: 'kind-counts',
    description: 'Histogram of symbol kinds in the codebase',
    agent: agentContract(
      'How many indexed symbols exist for each kind?',
      'symbol-kind counts',
      [],
      'complete',
      'repository',
    ),
    options: [option('-s, --scope <path>', 'Limit to files matching path')],
    docs: doc('Navigation'),
    headers: ['count', 'kind'],
    query: ({ db, opts }) => queries.kindCounts(db, { scope: stringOptionValue(opts, 'scope') }),
    format: (r) => `  ${String(r.count).padStart(5)}  ${r.kindName} (${r.kind})`,
  }),
  listQueryCommand({
    id: 'hierarchy',
    command: 'hierarchy <symbol>',
    description: "Show a symbol's ancestry chain (method → class → module)",
    agent: agentContract(
      'What lexical ownership chain contains this symbol?',
      'ancestor symbol identities and depths',
      ['symbol'],
      'complete',
    ),
    docs: doc('Navigation'),
    query: ({ db, args }) => queries.hierarchy(db, stringArg(args, 0)),
    format: (node) => `${'  '.repeat(node.depth)}${node.shortName}`,
    before: (_rows, { db, args }) => symbolResolutionBefore(db, stringArg(args, 0)),
    emptyMessage: ({ db, args }) => symbolResolutionEmptyMessage(db, stringArg(args, 0), 'Symbol not found.'),
    toJson: (rows, { db, args }) => withSymbolResolutionJson(db, stringArg(args, 0), rows, 'hierarchy'),
  }),
  {
    id: 'dataflow',
    command: 'dataflow <symbol>',
    description: 'Reference-level dataflow: definition sites, usage sites, producers, consumers',
    agent: agentContract(
      'What defines, uses, produces, and consumes this symbol?',
      'definition sites, usage sites, producer symbols, and consumer symbols',
      ['symbol'],
      'bounded',
    ),
    options: withJsonOption([option('--full', 'Run unbounded semantic analysis on large indexes')]),
    budget: 'semantic',
    renderShape: 'custom',
    docs: doc('Navigation'),
    handler: handleDataflow,
  },
  {
    id: 'slice',
    command: 'slice <symbol>',
    description: 'Reference-level program slice: what affects this (backward) or what this affects (forward)',
    agent: agentContract(
      'What transitively affects this symbol, or what does it affect?',
      'connected symbols with relationship and depth',
      ['symbol'],
      'bounded',
    ),
    options: withJsonOption([
      option('--forward', 'Forward slice (what does this affect). Default is backward.'),
      option('--depth <n>', 'Max transitive depth for backward slice', parseInteger, 3),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ]),
    budget: 'semantic',
    renderShape: 'custom',
    docs: doc('Navigation'),
    handler: handleSlice,
  },
];
