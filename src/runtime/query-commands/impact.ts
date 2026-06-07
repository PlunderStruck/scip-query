import * as queries from '../../queries/index.js';
import type { CommandDescriptor } from '../command-descriptor-types.js';
import { doc, option, parseInteger } from '../command-spec-builders.js';
import {
  budgetedDbCommand,
  dbCommand,
  definedNumberOption,
  stringArg,
  stringOptionValue,
} from '../command-execution.js';
import { displayRange, render } from '../render.js';

const handleAffected = dbCommand(({ db, args, opts }) => {
  const results = queries.affected(db, stringArg(args, 0), {
    maxDepth: definedNumberOption(opts, 'maxDepth', 5),
    scope: stringOptionValue(opts, 'scope'),
  });
  if (results.length === 0) return render.empty('No affected symbols found.');
  let prevDepth = -1;
  for (const r of results) {
    if (r.depth !== prevDepth) {
      console.log(`\n  ── Depth ${r.depth} ──`);
      prevDepth = r.depth;
    }
    console.log(`  ${r.file}  ${r.shortName}`);
  }
  console.log(`\n${results.length} affected symbol(s) across ${new Set(results.map((r) => r.file)).size} files.`);
});

const handleChangeSurface = budgetedDbCommand('change-surface', ({ db, args, budget }) => {
  const result = queries.changeSurface(db, stringArg(args, 0), { semantic: budget.semantic });
  if (!result) return render.empty('File not found in index.');
  console.log(`File: ${result.file}`);
  console.log(`External consumers: ${result.totalExternalConsumers}\n`);
  render.list(result.symbols, (s) => {
    const risk = s.riskLevel === 'high' ? ' *** HIGH RISK ***' : s.riskLevel === 'medium' ? ' * medium risk *' : '';
    return `  ${displayRange(s.startLine, s.endLine)}  ${s.shortName}  [${s.externalConsumers} consumers]${risk}`;
  });
});

export const impactQueryCommandDescriptors: CommandDescriptor[] = [
  {
    id: 'affected',
    command: 'affected <symbol>',
    description: 'Transitive closure of symbols that could break if this symbol changes',
    options: [
      option('--max-depth <n>', 'Maximum traversal depth', parseInteger, 5),
      option('-s, --scope <path>', 'Limit to files matching path'),
    ],
    renderShape: 'custom',
    docs: doc('Impact'),
    handler: handleAffected,
  },
  {
    id: 'change-surface',
    command: 'change-surface <file>',
    description: 'Pre-change briefing: exports, consumers, and blast-radius risk',
    options: [option('--full', 'Run unbounded semantic analysis on large indexes')],
    budget: 'semantic',
    renderShape: 'list',
    docs: doc('Impact'),
    handler: handleChangeSurface,
  },
];
