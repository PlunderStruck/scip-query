import { code } from '../../queries/navigation/code.js';
import { outline } from '../../queries/navigation/outline.js';
import { refs } from '../../queries/navigation/refs.js';
import type { CommandDescriptor } from '../command-kit/command-descriptor-types.js';
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
import { decodeResultCursor, encodeResultCursor, indexGenerationIdentity } from '../result-pagination.js';
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
  const allRows = refs(db, target, { semantic: budget.semantic }).sort(
    (left, right) => left.relativePath.localeCompare(right.relativePath) || left.line - right.line,
  );
  const cursor = stringOptionValue(opts, 'cursor');
  const requestedLimit = numberOptionValue(opts, 'limit');
  const limit = requestedLimit ?? (cursor ? 50 : allRows.length);
  const indexGeneration = indexGenerationIdentity(db);
  const offset = cursor ? decodeResultCursor(cursor, { command: 'refs', target, indexGeneration }).offset : 0;
  if (offset > allRows.length) {
    throw new Error('This cursor points past the current result set. Run again without --cursor.');
  }
  const rows = allRows.slice(offset, offset + limit);
  const nextOffset = offset + rows.length;
  const continuation =
    nextOffset < allRows.length
      ? {
          cursor: encodeResultCursor({ command: 'refs', target, offset: nextOffset, indexGeneration }),
          indexGeneration,
        }
      : undefined;
  const coverage = {
    complete: offset === 0 && rows.length === allRows.length,
    totalKnown: true,
    returned: rows.length,
    total: allRows.length,
    omitted: allRows.length - rows.length,
    ...(continuation ? { continuation } : {}),
  } as const;

  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('refs', args, opts, withSymbolResolutionJson(db, target, rows, 'references'), {
      analysisBudget: budget.analysisBudget,
      coverage,
    });
    return;
  }
  if (rows.length === 0) return render.empty(symbolResolutionEmptyMessage(db, target, 'No references found.'));
  symbolResolutionBefore(db, target);
  render.groupedByFile(rows, (reference) => `  line ${displayLine(reference.line)}`);
  if (continuation) console.log(`\n${coverage.omitted} omitted; continue with --cursor ${continuation.cursor}`);
});

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
    agent: agentContract(
      'What is the compiler-resolved definition source for this symbol?',
      'definition identity, source, and line range',
      ['symbol'],
      'complete',
    ),
    options: withJsonOption([option('-C, --context <n>', 'Extra lines of context above/below', parseInteger, 0)]),
    renderShape: 'custom',
    docs: doc('Navigation'),
    handler: handleCode,
  },
];
