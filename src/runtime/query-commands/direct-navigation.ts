import {
  codeBatch,
  type CodeBatchEntry,
  type CodeBatchResult,
  type CodeFileMemberMode,
  type CodeResult,
} from '../../queries/navigation/code.js';
import { outline } from '../../queries/navigation/outline.js';
import { refs } from '../../queries/navigation/refs.js';
import { commandOperation, REPOSITORY_OBSERVATION_OPERATION } from '../command-operation.js';
import { compareReferenceKey, referencePage } from '../refs-pagination.js';
import type { CommandDescriptor, InvocationCoverage } from '../command-kit/command-descriptor-types.js';
import {
  doc,
  agentContract,
  analysisSemanticContract,
  locatorSemanticContract,
  maintenanceAgentContract,
  option,
  parseNonNegativeInteger,
  parsePositiveInteger,
  withCompactJsonOptions,
  withJsonOption,
  sourceReadSemanticContract,
} from '../command-kit/command-spec-builders.js';
import {
  booleanOptionValue,
  budgetedDbCommand,
  dbCommand,
  definedNumberOption,
  numberOptionValue,
  printJsonEnvelope,
  stringArg,
  stringArrayArg,
  stringOptionValue,
} from '../command-kit/command-execution.js';
import { decodeCompatibleResultCursor, encodeResultCursor, indexGenerationIdentity } from '../result-pagination.js';
import { displayLine, displayPathRange, displayRange, render } from '../render.js';
import { renderSourceEvidence, sourceEmissionSessionSummary } from '../source-emission-session.js';
import {
  noMatchMessage,
  symbolResolutionBefore,
  symbolResolutionEmptyMessage,
  withSymbolResolutionJson,
} from './symbol-resolution.js';
import {
  codeBatchResultOnlyJson,
  codeResultOnlyJson,
  singleExactCodeResult,
} from '../../queries/navigation/code-result-json.js';

const handleOutline = dbCommand(({ db, args, opts }) => {
  const filePattern = stringArg(args, 0);
  const showSignatures = booleanOptionValue(opts, 'signatures');
  const roots = outline(db, filePattern);
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('outline', args, opts, roots);
    return;
  }
  console.log(
    `═══ REQUEST ═══\n  file=${JSON.stringify(filePattern)}; signatures=${showSignatures ? 'shown' : 'hidden'}`,
  );
  if (roots.length === 0) {
    console.log(
      `\n═══ OBSERVED FACTS ═══\n  No compiler-owned constructs were found for ${JSON.stringify(filePattern)}.`,
    );
    console.log(
      '\n═══ EVIDENCE CALIBRATION ═══\n  Missing compiler constructs do not establish that the current text file is empty or irrelevant.',
    );
    console.log('\n═══ COVERAGE ═══\n  Compiler ownership is unavailable or empty for this exact file selector.');
    console.log(
      `\n═══ RECOVERY ═══\n  Read current source exactly with: scip-query code ${shellArgument(filePattern)}`,
    );
    return;
  }

  function printTree(nodes: typeof roots, indent: number): void {
    for (const node of nodes) {
      const prefix = '  '.repeat(indent);
      const signature = showSignatures && node.signature ? `  - ${trimSignature(node.signature)}` : '';
      console.log(`${prefix}${displayRange(node.startLine, node.endLine)}  ${node.shortName}${signature}`);
      printTree(node.children, indent + 1);
    }
  }
  console.log('\n═══ OBSERVED FACTS ═══');
  printTree(roots, 0);
  console.log(
    '\n═══ EVIDENCE CALIBRATION ═══\n  These are compiler-owned identities and source ranges. Ownership and nesting do not establish execution or task relevance.',
  );
  console.log(
    `\n═══ COVERAGE ═══\n  ${outlineNodeCount(roots)} compiler construct(s) returned in ${roots.length} top-level tree(s).`,
  );
  console.log(
    '\n═══ RECOVERY ═══\n  Every displayed file:line is an exact evidence root. Exact top-level symbol selectors:',
  );
  for (const node of roots) {
    const symbol = `'${node.symbol.replaceAll("'", "'\\''")}'`;
    console.log(`  ${node.shortName}: ${symbol}`);
  }
});

function outlineNodeCount(nodes: ReturnType<typeof outline>): number {
  return nodes.reduce((total, node) => total + 1 + outlineNodeCount(node.children), 0);
}

function trimSignature(signature: string): string {
  const maxLength = 120;
  return signature.length > maxLength ? `${signature.slice(0, maxLength - 3)}...` : signature;
}

const handleRefs = budgetedDbCommand('refs', ({ db, args, opts, budget }) => {
  const target = stringArg(args, 0);
  const cursor = stringOptionValue(opts, 'cursor');
  const requestedLimit = numberOptionValue(opts, 'limit');
  const indexGeneration = indexGenerationIdentity(db);
  const decodedCursor = cursor
    ? decodeCompatibleResultCursor(cursor, { command: 'refs', target, indexGeneration })
    : undefined;
  const unpaginated = !decodedCursor && requestedLimit === undefined;
  const page = unpaginated
    ? completeUnpaginatedRefs(db, target, budget.semantic)
    : decodedCursor?.version === 1
      ? legacyOffsetPage(db, target, decodedCursor.offset, requestedLimit ?? 50, budget.semantic)
      : keysetReferencePage(db, target, {
          limit: requestedLimit ?? 50,
          cursor: decodedCursor,
          semantic: decodedCursor?.semanticEnrichment ?? booleanOptionValue(opts, 'full'),
          indexGeneration,
        });
  const { rows, continuation, coverage } = page;

  if (booleanOptionValue(opts, 'json')) {
    const result = {
      ...withSymbolResolutionJson(db, target, rows, 'references'),
      pagination: page.pagination,
    };
    printJsonEnvelope('refs', args, opts, result, {
      analysisBudget: budget.analysisBudget,
      coverage,
    });
    return;
  }
  if (rows.length === 0) return render.empty(symbolResolutionEmptyMessage(db, target, 'No references found.'));
  symbolResolutionBefore(db, target);
  render.groupedByFile(
    rows,
    (reference) => `  line ${displayLine(reference.line)} [${reference.evidence ?? 'source-or-chunk-candidate'}]`,
  );
  if (page.pagination.producer === 'complete-only' && !unpaginated) {
    console.error(
      '\nThis evidence provider required complete analysis; --limit bounded the returned rows, not analysis work.',
    );
  }
  if (continuation) {
    const omitted = coverage.totalKnown ? `${coverage.omitted} omitted; ` : 'More references are available; ';
    console.log(`\n${omitted}continue with --cursor ${continuation.cursor}`);
  }
});

interface RenderedRefPage {
  rows: ReturnType<typeof refs>;
  continuation?: { cursor: string; indexGeneration: string };
  coverage: InvocationCoverage;
  pagination: {
    cursorVersion: 1 | 2;
    producer: 'source-keyset' | 'complete-only';
    semanticEnrichment: boolean;
  };
}

function completeUnpaginatedRefs(db: Parameters<typeof refs>[0], target: string, semantic: boolean): RenderedRefPage {
  const rows = refs(db, target, { semantic }).sort(compareReferenceKey);
  return {
    rows,
    coverage: {
      complete: true,
      totalKnown: true,
      returned: rows.length,
      total: rows.length,
      omitted: 0,
    },
    pagination: { cursorVersion: 2, producer: 'complete-only', semanticEnrichment: semantic },
  };
}

function legacyOffsetPage(
  db: Parameters<typeof refs>[0],
  target: string,
  offset: number,
  limit: number,
  semantic: boolean,
): RenderedRefPage {
  const allRows = refs(db, target, { semantic }).sort(compareReferenceKey);
  if (offset > allRows.length) {
    throw new Error('This cursor points past the current result set. Run again without --cursor.');
  }
  const rows = allRows.slice(offset, offset + limit);
  const nextOffset = offset + rows.length;
  const lastRow = rows[rows.length - 1];
  const complete = offset === 0 && rows.length === allRows.length;
  const continuation =
    nextOffset < allRows.length && lastRow
      ? {
          cursor: encodeResultCursor({
            command: 'refs',
            target,
            after: lastRow,
            producer: 'complete-only',
            semanticEnrichment: semantic,
            indexGeneration: indexGenerationIdentity(db),
          }),
          indexGeneration: indexGenerationIdentity(db),
        }
      : undefined;
  return {
    rows,
    continuation,
    coverage: complete
      ? { complete: true, totalKnown: true, returned: rows.length, total: rows.length, omitted: 0 }
      : {
          complete: false,
          totalKnown: true,
          returned: rows.length,
          total: allRows.length,
          omitted: allRows.length - rows.length,
          ...(continuation ? { continuation } : {}),
        },
    pagination: { cursorVersion: 2, producer: 'complete-only', semanticEnrichment: semantic },
  };
}

function keysetReferencePage(
  db: Parameters<typeof refs>[0],
  target: string,
  input: {
    limit: number;
    cursor?: Extract<ReturnType<typeof decodeCompatibleResultCursor>, { version: 2 }>;
    semantic: boolean;
    indexGeneration: string;
  },
): RenderedRefPage {
  const result = referencePage(db, target, {
    limit: input.limit,
    after: input.cursor?.after,
    producer: input.cursor?.producer,
    semantic: input.semantic,
  });
  const lastRow = result.rows[result.rows.length - 1];
  const continuation =
    result.hasMore && lastRow
      ? {
          cursor: encodeResultCursor({
            command: 'refs',
            target,
            after: lastRow,
            producer: result.producer,
            semanticEnrichment: result.semanticEnrichment,
            indexGeneration: input.indexGeneration,
          }),
          indexGeneration: input.indexGeneration,
        }
      : undefined;
  const complete = !input.cursor && !result.hasMore;
  return {
    rows: result.rows,
    continuation,
    coverage: complete
      ? {
          complete: true,
          totalKnown: true,
          returned: result.rows.length,
          total: result.rows.length,
          omitted: 0,
        }
      : {
          complete: false,
          totalKnown: false,
          returned: result.rows.length,
          ...(continuation ? { continuation } : {}),
        },
    pagination: {
      cursorVersion: 2,
      producer: result.producer,
      semanticEnrichment: result.semanticEnrichment,
    },
  };
}

const handleCode = dbCommand(({ db, args, opts }) => {
  const selectors = stringArrayArg(args, 0);
  const context = definedNumberOption(opts, 'context', 0);
  const members = codeFileMemberMode(opts);
  const result = codeBatch(db, selectors, { context, members, localCalls: booleanOptionValue(opts, 'localCalls') });
  const single = singleExactCodeResult(result);
  if (booleanOptionValue(opts, 'json')) {
    if (single) {
      const query = selectors[0]!;
      printJsonEnvelope('code', selectors, opts, withSymbolResolutionJson(db, query, single, 'code'), {
        resultOnly: codeResultOnlyJson(db, query, single),
      });
      return;
    }
    printJsonEnvelope('code', selectors, opts, result, {
      coverage: {
        complete: true,
        totalKnown: true,
        returned: result.entries.length,
        total: result.requested,
        omitted: 0,
      },
      resultOnly: codeBatchResultOnlyJson(result),
    });
    return;
  }
  const packet = single ? codeResultText(single, result.bindingClosure, true) : codeBatchText(result, true);
  if (single) {
    process.stdout.write(packet);
    return;
  }
  const onlyEntry = result.entries[0];
  if (result.requested === 1 && onlyEntry?.status === 'missing') {
    return render.empty(noMatchMessage(onlyEntry.selector, onlyEntry.suggestions));
  }
  process.stdout.write(packet);
});

const handleSourceSession = dbCommand(({ opts }) => {
  const reset = booleanOptionValue(opts, 'reset');
  const summary = sourceEmissionSessionSummary(reset);
  if (!summary.enabled) {
    render.empty(summary.reason ?? 'Exploration-session deduplication is unavailable.');
    return;
  }
  console.log(
    reset
      ? 'Exploration-session ledger reset; subsequent exploration will emit evidence again.'
      : `Exploration session: ${summary.uniqueLines.toLocaleString()} unique source line(s) and ` +
          `${summary.evidenceItems.toLocaleString()} graph evidence item(s) delivered across ${summary.emissions.toLocaleString()} emission(s).`,
  );
  if (!reset && summary.rows.length > 0) console.log(summary.rows.join('\n'));
});

function codeFileMemberMode(opts: Readonly<Record<string, unknown>>): CodeFileMemberMode {
  const value = stringOptionValue(opts, 'members') ?? 'exported';
  if (value === 'exported' || value === 'all') return value;
  throw new RangeError(`--members must be "exported" or "all", got "${value}".`);
}

function codeBatchText(result: CodeBatchResult, sessionAware = false): string {
  const lines: string[] = [
    '═══ REQUEST ═══',
    `  ${result.entries.map((entry) => entry.selector).join(', ')}`,
    '',
    `═══ OBSERVED FACTS (${result.requested} requested: ${result.matched} matched, ${result.ambiguous} ambiguous, ${result.missing} missing) ═══`,
  ];
  const rendered = new Set<string>();
  for (const entry of result.entries) {
    for (const source of entry.results) {
      const key = `${source.relativePath}:${source.startLine}:${source.endLine}`;
      if (rendered.has(key)) {
        lines.push(
          '',
          `  ${entry.selector}: source already included at ${displayPathRange(source.relativePath, source.startLine, source.endLine)}.`,
        );
        continue;
      }
      rendered.add(key);
      if (result.requested > 1 || entry.status === 'ambiguous') lines.push('', `  selector ${entry.selector}`);
      appendCodeResult(lines, source, sessionAware);
    }
  }

  const fileSources = result.entries.filter((entry) => entry.kind === 'file-source');
  if (fileSources.length > 0) {
    lines.push('', '═══ FILE SOURCE COVERAGE ═══');
    for (const entry of fileSources) appendCodeFileCoverage(lines, entry);
  }

  const rangeSources = result.entries.filter((entry) => entry.rangeCoverage);
  if (rangeSources.length > 0) {
    lines.push('', '═══ RANGE SOURCE COVERAGE ═══');
    for (const entry of rangeSources) appendCodeRangeCoverage(lines, entry);
  }

  const ambiguous = result.entries.filter((entry) => entry.status === 'ambiguous');
  if (ambiguous.length > 0) {
    lines.push('', '═══ AMBIGUOUS SELECTORS ═══');
    for (const entry of ambiguous) appendCodeAmbiguity(lines, entry);
  }

  const missing = result.entries.filter((entry) => entry.status === 'missing');
  if (missing.length > 0) {
    lines.push('', '═══ MISSING SELECTORS ═══');
    for (const entry of missing) {
      const suggestions = entry.suggestions.length > 0 ? ` Suggestions: ${entry.suggestions.join(', ')}` : '';
      lines.push(
        `  ${entry.selector}: ${entry.reason === 'definition-source-unreadable' ? 'definition source unreadable.' : 'no definition matched.'}${suggestions}`,
      );
    }
  }
  appendCodeBindingClosure(lines, result.bindingClosure);
  appendCodeFreshness(
    lines,
    result.entries.flatMap((entry) => entry.results),
  );
  appendCodeCoverage(lines, result);
  return `${lines.join('\n')}\n`;
}

function appendCodeRangeCoverage(lines: string[], entry: CodeBatchEntry): void {
  const coverage = entry.rangeCoverage;
  if (!coverage) return;
  lines.push(
    `  ${entry.selector} — requested lines returned plus ${coverage.returnedBodies} same-file callable body(ies), covering ${coverage.returnedDefinitions}/${coverage.referencedDefinitions} statically attributed same-file definition(s).`,
    `    basis: ${coverage.basis}; dynamic calls and references outside the requested lines are not claimed`,
  );
  if (coverage.omittedLedger.length === 0) return;
  lines.push('    OMITTED REFERENCED DEFINITIONS');
  for (const definition of coverage.omittedLedger) {
    lines.push(
      `      ${displayPathRange(definition.relativePath, definition.startLine, definition.endLine)}  ${definition.shortName}`,
    );
  }
}

function codeResultText(result: CodeResult, closure?: CodeResult['bindingClosure'], sessionAware = false): string {
  const lines: string[] = ['═══ REQUEST ═══', `  resolved-selector=${result.symbol}`, '', '═══ OBSERVED FACTS ═══'];
  appendCodeResult(lines, result, sessionAware);
  appendCodeBindingClosure(lines, closure);
  appendCodeFreshness(lines, [result]);
  lines.push(
    '',
    '═══ COVERAGE ═══',
    '  One exact selector resolved to the complete source body shown; callers and runtime relationships are not implied.',
  );
  return `${lines.join('\n')}\n`;
}

function appendCodeFreshness(lines: string[], results: readonly CodeResult[]): void {
  const observations = results.flatMap((result) => (result.freshness ? [result.freshness] : []));
  lines.push(
    '',
    '═══ EVIDENCE CALIBRATION ═══',
    '  Source bodies are exact working-tree bytes; compiler identity and bindings are limited to reported semantic coverage.',
  );
  if (observations.length === 0) {
    lines.push('  No source-freshness overlay was available.');
    return;
  }
  const semantic = {
    aligned: observations.filter((item) => item.semantic.state === 'aligned').length,
    stale: observations.filter((item) => item.semantic.state === 'stale').length,
    unavailable: observations.filter((item) => item.semantic.state === 'unavailable').length,
  };
  lines.push(
    `  Freshness: ${observations.length}/${results.length} text current; semantics ${semantic.aligned} aligned, ${semantic.stale} stale, ${semantic.unavailable} unavailable.`,
  );
}

function appendCodeResult(lines: string[], result: CodeResult, sessionAware: boolean): void {
  if (sessionAware) {
    lines.push(
      renderSourceEvidence({
        relativePath: result.relativePath,
        startLine: result.startLine,
        source: result.source,
        sessionPolicy: 'exact-unit',
        ownerSymbol: result.shortName,
        headerSuffix: `  ${result.shortName}  [${result.language ?? 'unknown'}]`,
        indent: '',
        sourceIndent: '  ',
        showFocusMarker: false,
        lineNumberWidth: 4,
        blankAfterHeader: true,
      }),
    );
    return;
  }
  lines.push(
    `${displayPathRange(result.relativePath, result.startLine, result.endLine)}  ${result.shortName}  [${result.language ?? 'unknown'}]`,
    '',
  );
  const sourceLines = result.source.split('\n');
  for (let index = 0; index < sourceLines.length; index++) {
    lines.push(`  ${String(displayLine(result.startLine + index)).padStart(4)}  ${sourceLines[index]}`);
  }
}

function appendCodeFileCoverage(lines: string[], entry: CodeBatchEntry): void {
  const coverage = entry.fileCoverage;
  if (!coverage) return;
  lines.push(
    `  ${entry.selector} — ${coverage.returnedBodies} source body(ies) cover ${coverage.returnedDefinitions}/${coverage.totalDefinitions} indexed definition(s); ${coverage.omittedDefinitions} omitted definition(s) disclosed below.`,
    `    basis: ${coverage.basis}; members=${coverage.members}`,
  );
  if (coverage.omittedLedger.length === 0) return;
  lines.push('    OMITTED FILE-LOCAL DEFINITIONS');
  for (const definition of coverage.omittedLedger) {
    const signature = definition.signature ? ` — ${trimSignature(definition.signature)}` : '';
    const nested = definition.nestedDefinitions > 0 ? ` (+${definition.nestedDefinitions} nested definition(s))` : '';
    lines.push(
      `      ${'  '.repeat(definition.depth)}${displayPathRange(definition.relativePath, definition.startLine, definition.endLine)}  ${definition.shortName}${signature}${nested}`,
    );
  }
  const omittedRoots = coverage.omittedLedger.filter((definition) => definition.depth === 0);
  for (let index = 0; index < omittedRoots.length; index += 24) {
    const group = omittedRoots.slice(index, index + 24);
    lines.push(
      `    Read omitted units together: scip-query code ${group
        .map((definition) =>
          shellArgument(
            `${definition.relativePath}:${displayLine(definition.startLine)}-${displayLine(definition.endLine)}`,
          ),
        )
        .join(' ')}`,
    );
  }
}

function appendCodeAmbiguity(lines: string[], entry: CodeBatchEntry): void {
  lines.push(
    `  ${entry.selector} — ${entry.totalCandidates} candidate(s); ${entry.results.length > 0 ? 'all candidate bodies returned above' : 'no body selected'}.`,
  );
  for (const candidate of entry.candidates) {
    lines.push(
      `    ${displayPathRange(candidate.relativePath, candidate.startLine, candidate.endLine)}  ${candidate.shortName}`,
    );
  }
  if (entry.omittedCandidates > 0) lines.push(`    ... ${entry.omittedCandidates} additional candidate identity(ies).`);
  if (entry.candidates.length > 0) {
    lines.push(
      `    Read shown candidates together: scip-query code ${entry.candidates
        .map((candidate) =>
          shellArgument(
            `${candidate.relativePath}:${displayLine(candidate.startLine)}-${displayLine(candidate.endLine)}`,
          ),
        )
        .join(' ')}`,
    );
  }
}

function appendCodeBindingClosure(lines: string[], closure: CodeResult['bindingClosure']): void {
  if (!closure || closure.inline.length === 0) return;
  lines.push('', 'LITERAL VALUES');
  for (const binding of closure.inline) {
    lines.push(
      `  inline  ${binding.name} @ ${displayPathRange(binding.relativePath, binding.startLine, binding.endLine)}`,
    );
    lines.push(`    ${binding.source ?? ''}`);
  }
}

function appendCodeCoverage(lines: string[], result: CodeBatchResult): void {
  const resolved = result.entries.filter((entry) => entry.status === 'matched').length;
  const fileCoverage = result.entries.flatMap((entry) => (entry.fileCoverage ? [entry.fileCoverage] : []));
  const rangeCoverage = result.entries.flatMap((entry) => (entry.rangeCoverage ? [entry.rangeCoverage] : []));
  if (fileCoverage.length === 0 && rangeCoverage.length === 0) {
    lines.push(
      '',
      '═══ COVERAGE ═══',
      `  ${resolved}/${result.requested} selector(s) resolved to shown source bodies; referenced definitions and runtime relationships are not claimed. Source lines use absolute file line numbers and are citation-ready.`,
    );
    return;
  }
  const returnedBodies = fileCoverage.reduce((total, coverage) => total + coverage.returnedBodies, 0);
  const returnedDefinitions = fileCoverage.reduce((total, coverage) => total + coverage.returnedDefinitions, 0);
  const totalDefinitions = fileCoverage.reduce((total, coverage) => total + coverage.totalDefinitions, 0);
  const omittedDefinitions = fileCoverage.reduce((total, coverage) => total + coverage.omittedDefinitions, 0);
  const rangeReferencedDefinitions = rangeCoverage.reduce(
    (total, coverage) => total + coverage.referencedDefinitions,
    0,
  );
  const rangeReturnedDefinitions = rangeCoverage.reduce((total, coverage) => total + coverage.returnedDefinitions, 0);
  const rangeOmittedDefinitions = rangeCoverage.reduce((total, coverage) => total + coverage.omittedDefinitions, 0);
  const details = [
    ...(fileCoverage.length > 0
      ? [
          `${fileCoverage.length} file selector(s) returned ${returnedBodies} source body(ies) covering ${returnedDefinitions}/${totalDefinitions} indexed definition(s); ${omittedDefinitions} file-local definition(s) omitted and disclosed`,
        ]
      : []),
    ...(rangeCoverage.length > 0
      ? [
          `${rangeCoverage.length} range selector(s) covered ${rangeReturnedDefinitions}/${rangeReferencedDefinitions} statically attributed same-file definition(s); ${rangeOmittedDefinitions} referenced definition(s) omitted and disclosed`,
        ]
      : []),
  ];
  lines.push(
    '',
    '═══ COVERAGE ═══',
    `  ${resolved}/${result.requested} selectors resolved; ${details.join('; ')}. Source lines use absolute file line numbers and are citation-ready.`,
  );
}

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * These direct-navigation descriptors are command definitions whose
 * handlers depend only on their own query modules, allowing these common
 * invocations to load without initializing the complete command catalog.
 */
export const directNavigationQueryCommandDescriptors: CommandDescriptor[] = [
  {
    id: 'session',
    command: 'session',
    description: 'Show evidence already delivered in this agent exploration session',
    options: [option('--reset', 'Clear this agent exploration-session ledger')],
    agent: maintenanceAgentContract(
      'Which indexed source ranges and graph facts have already been delivered in this exploration session?',
      'prior command ordinals, exact source ranges, and content-bound graph receipts',
      [],
      'complete',
      'repository',
      commandOperation('repository-observation', [
        { when: { kind: 'option', name: 'reset', equals: true }, role: 'mutation' },
      ]),
    ),
    renderShape: 'custom',
    docs: doc('Navigation'),
    handler: handleSourceSession,
  },
  {
    id: 'refs',
    command: 'refs <symbol>',
    description: 'Find all files referencing a symbol',
    options: withCompactJsonOptions([
      option('--full', 'Run unbounded semantic analysis on large indexes'),
      option('-n, --limit <n>', 'Maximum reference sites to return', parsePositiveInteger),
      option('--cursor <cursor>', 'Continue a prior bounded result (implies --limit 50 when omitted)'),
    ]),
    budget: 'semantic',
    agent: {
      operation: REPOSITORY_OBSERVATION_OPERATION,
      answers: ['Which files reference this symbol?', 'Is this symbol used anywhere, or only defined?'],
      returns: ['referencing file paths', 'reference line numbers grouped by file'],
      inputs: ['symbol'],
      // Semantic analysis is budgeted on large indexes; --full lifts the cap.
      coverage: 'bounded',
      semantic: analysisSemanticContract(
        'Locate compiler-bound references and explicitly marked source/chunk candidates for one symbol identity.',
        'Referencing file paths and reference line numbers grouped by file.',
        [
          'Source/chunk candidates require confirmation; non-callable symbols include their definition site. Reference sites do not establish runtime execution or complete absence of uses.',
        ],
      ),
      contrasts: [
        {
          command: 'imported-by',
          distinction:
            'imported-by lists files importing the symbol; refs covers every reference site, imported or not.',
        },
        {
          command: 'affected',
          distinction:
            'refs lists observed locations; affected follows indexed dependency paths and does not prove that a consumer will break.',
        },
      ],
    },
    renderShape: 'grouped-by-file',
    docs: doc('Navigation', ['scip-query refs login']),
    handler: handleRefs,
  },
  {
    id: 'outline',
    command: 'outline <file>',
    description: 'Tree view of symbols in a file, with line ranges',
    agent: {
      ...agentContract(
        'What symbols and nesting exist in this file?',
        'symbol names, nesting, and line ranges',
        ['file'],
        'complete',
        undefined,
        REPOSITORY_OBSERVATION_OPERATION,
        locatorSemanticContract(
          ['file', 'symbol', 'construct'],
          ['File ownership and nesting do not establish execution or task relevance.'],
          {
            ranking: 'identity-only',
            manualInput: 'One exact current project file path.',
            evidenceCeiling:
              'Exact compiler-owned constructs and ranges when the file is indexed; no invented semantic overlay.',
          },
        ),
      ),
      contrasts: [
        {
          command: 'search',
          distinction:
            'outline enumerates constructs in one known file; search locates exact text across current project text.',
        },
        {
          command: 'code',
          distinction: 'outline returns identities and ranges; code materializes exact source for selected identities.',
        },
      ],
    },
    options: withJsonOption([option('--signatures', 'Show trimmed symbol signatures')]),
    renderShape: 'custom',
    docs: doc('Navigation'),
    handler: handleOutline,
  },
  {
    id: 'code',
    command: 'code <selectors...>',
    description: 'Read exact definitions, line ranges, or file export surfaces',
    agent: {
      ...agentContract(
        'What exact source defines these symbols, ranges, or file surfaces?',
        'per-selector resolution, complete definition source, exact ranges, optional same-file call closure, file export surfaces, and omitted-local ledgers',
        [['symbol', 'file']],
        'complete',
        undefined,
        REPOSITORY_OBSERVATION_OPERATION,
        sourceReadSemanticContract(
          ['construct', 'exact-source'],
          ['Source materialization does not establish callers, runtime reachability, or task relevance by itself.'],
          undefined,
          {
            manualInput: 'One or more exact symbols, file:line ranges, or file paths.',
            evidenceCeiling:
              'Exact current source bytes for every resolved selector, with omitted file-local constructs disclosed.',
          },
        ),
      ),
      resultUnits: { kind: 'field', field: 'code' },
      contrasts: [
        {
          command: 'inspect',
          distinction: 'code materializes complete exact source; inspect batches bounded behavior or source gaps.',
        },
        {
          command: 'outline',
          distinction:
            'code reads selected implementations; outline enumerates file structure without reading every body.',
        },
      ],
    },
    options: withJsonOption([
      option('-C, --context <n>', 'Extra lines of context above/below', parseNonNegativeInteger, 0),
      option('--local-calls', 'Also read statically attributed same-file callees of a selected line range'),
      option(
        '--members <exported|all>',
        'For file selectors, return the exported surface or the complete file',
        undefined,
        'exported',
      ),
    ]),
    renderShape: 'custom',
    docs: doc('Navigation', ['scip-query code parseRequest handleRequest', 'scip-query code src/api.ts src/web.ts']),
    handler: handleCode,
  },
];
