import { code } from '../../queries/navigation/code.js';
import { outline } from '../../queries/navigation/outline.js';
import { refs } from '../../queries/navigation/refs.js';
import type { CommandDescriptor } from '../commands/command-descriptor-types.js';
import { doc, option, parseInteger, withJsonOption } from '../commands/command-spec-builders.js';
import {
  booleanOptionValue,
  budgetedGroupedByFileCommand,
  dbCommand,
  definedNumberOption,
  printJsonEnvelope,
  stringArg,
} from '../commands/command-execution.js';
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

const handleRefs = budgetedGroupedByFileCommand('refs', {
  query: ({ db, args, budget }) => refs(db, stringArg(args, 0), { semantic: budget.semantic }),
  format: (reference) => `  line ${displayLine(reference.line)}`,
  before: (_rows, { db, args }) => symbolResolutionBefore(db, stringArg(args, 0)),
  emptyMessage: ({ db, args }) => symbolResolutionEmptyMessage(db, stringArg(args, 0), 'No references found.'),
  toJson: (rows, { db, args }) => withSymbolResolutionJson(db, stringArg(args, 0), rows, 'references'),
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
    options: [
      option('--full', 'Run unbounded semantic analysis on large indexes'),
      option('--json', 'Output as JSON for programmatic consumption'),
    ],
    budget: 'semantic',
    renderShape: 'grouped-by-file',
    docs: doc('Navigation', ['scip-query refs login']),
    handler: handleRefs,
  },
  {
    id: 'outline',
    command: 'outline <file>',
    description: 'Tree view of symbols in a file, with line ranges',
    options: withJsonOption([option('--signatures', 'Show trimmed symbol signatures')]),
    renderShape: 'custom',
    docs: doc('Navigation'),
    handler: handleOutline,
  },
  {
    id: 'code',
    command: 'code <symbol>',
    description: 'Read the source code for a symbol (bounded to its definition range)',
    options: withJsonOption([option('-C, --context <n>', 'Extra lines of context above/below', parseInteger, 0)]),
    renderShape: 'custom',
    docs: doc('Navigation'),
    handler: handleCode,
  },
];
