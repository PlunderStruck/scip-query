import { code } from '../../queries/navigation/code.js';
import { outline } from '../../queries/navigation/outline.js';
import { refs } from '../../queries/navigation/refs.js';
import { compareReferenceKey, referencePage } from '../refs-pagination.js';
import type { CommandDescriptor, InvocationCoverage } from '../command-kit/command-descriptor-types.js';
import {
  doc,
  agentContract,
  option,
  parseInteger,
  parsePositiveInteger,
  withCompactJsonOptions,
  withJsonOption,
} from '../command-kit/command-spec-builders.js';
import {
  booleanOptionValue,
  budgetedDbCommand,
  dbCommand,
  definedNumberOption,
  numberOptionValue,
  printJsonEnvelope,
  stringArg,
  stringOptionValue,
} from '../command-kit/command-execution.js';
import { decodeCompatibleResultCursor, encodeResultCursor, indexGenerationIdentity } from '../result-pagination.js';
import { displayLine, displayPathRange, displayRange, render } from '../render.js';
import { symbolResolutionBefore, symbolResolutionEmptyMessage, withSymbolResolutionJson } from './symbol-resolution.js';

const handleOutline = dbCommand(({ db, args, opts }) => {
  const filePattern = stringArg(args, 0);
  const showSignatures = booleanOptionValue(opts, 'signatures');
  const roots = outline(db, filePattern);
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('outline', args, opts, roots);
    return;
  }
  if (roots.length === 0) {
    return render.empty(`No symbols found for "${filePattern}".`);
  }

  function printTree(nodes: typeof roots, indent: number): void {
    for (const node of nodes) {
      const prefix = '  '.repeat(indent);
      const signature = showSignatures && node.signature ? `  - ${trimSignature(node.signature)}` : '';
      console.log(`${prefix}${displayRange(node.startLine, node.endLine)}  ${node.shortName}${signature}`);
      printTree(node.children, indent + 1);
    }
  }
  printTree(roots, 0);
});

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
  render.groupedByFile(rows, (reference) => `  line ${displayLine(reference.line)}`);
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
  const query = stringArg(args, 0);
  const result = code(db, query, { context: definedNumberOption(opts, 'context', 0) });
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('code', args, opts, withSymbolResolutionJson(db, query, result, 'code'));
    return;
  }
  if (!result) return render.empty(symbolResolutionEmptyMessage(db, query, 'Symbol found, but source was unreadable.'));
  symbolResolutionBefore(db, query);
  console.log(
    `${displayPathRange(result.relativePath, result.startLine, result.endLine)}  ${result.shortName}  [${result.language ?? 'unknown'}]\n`,
  );
  const lines = result.source.split('\n');
  for (let index = 0; index < lines.length; index++) {
    console.log(`  ${String(displayLine(result.startLine + index)).padStart(4)}  ${lines[index]}`);
  }
});

/**
 * The three direct-navigation descriptors are command definitions whose
 * handlers depend only on their own query modules, allowing these common
 * invocations to load without initializing the complete command catalog.
 */
export const directNavigationQueryCommandDescriptors: CommandDescriptor[] = [
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
      answers: ['Which files reference this symbol?', 'Is this symbol used anywhere, or only defined?'],
      returns: ['referencing file paths', 'reference line numbers grouped by file'],
      inputs: ['symbol'],
      // Semantic analysis is budgeted on large indexes; --full lifts the cap.
      coverage: 'bounded',
      contrasts: [
        {
          command: 'imported-by',
          distinction:
            'imported-by lists files importing the symbol; refs covers every reference site, imported or not.',
        },
        {
          command: 'affected',
          distinction: 'refs is one hop out; affected is the transitive closure of what could break.',
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
    agent: agentContract(
      'What symbols and nesting exist in this file?',
      'symbol names, nesting, and line ranges',
      ['file'],
      'complete',
    ),
    options: withJsonOption([option('--signatures', 'Show trimmed symbol signatures')]),
    renderShape: 'custom',
    docs: doc('Navigation'),
    handler: handleOutline,
  },
  {
    id: 'code',
    command: 'code <symbol>',
    description: 'Read the source code for a symbol (bounded to its definition range)',
    agent: {
      ...agentContract(
        'What is the compiler-resolved definition source for this symbol?',
        'definition identity, source, and line range',
        ['symbol'],
        'complete',
      ),
      resultUnits: { kind: 'field', field: 'code' },
    },
    options: withJsonOption([option('-C, --context <n>', 'Extra lines of context above/below', parseInteger, 0)]),
    renderShape: 'custom',
    docs: doc('Navigation'),
    handler: handleCode,
  },
];
