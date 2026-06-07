import * as queries from '../../queries/index.js';
import type { CommandDescriptor } from '../command-descriptor-types.js';
import { doc, option } from '../command-spec-builders.js';
import { budgetedDbCommand, stringArg } from '../command-execution.js';
import { displayPathRange, render } from '../render.js';

const handleComplexity = budgetedDbCommand('complexity', ({ db, args, budget }) => {
  const result = queries.complexity(db, stringArg(args, 0), { semantic: budget.semantic });
  if (!result) return render.empty('Symbol not found.');
  console.log(`${displayPathRange(result.relativePath, result.startLine, result.endLine)}  ${result.shortName}\n`);
  console.log(`  LOC:                  ${result.loc}`);
  console.log(`  Branches:             ${result.branches}`);
  console.log(`  Cyclomatic estimate:  ${result.cyclomaticEstimate}`);
  console.log(`  Callees:              ${result.calleeCount}`);
  console.log(`  Fan-in:               ${result.fanIn}`);
  console.log(`  Fan-out:              ${result.fanOut}`);
});

export const healthQueryCommandDescriptors: CommandDescriptor[] = [
  {
    id: 'complexity',
    command: 'complexity <symbol>',
    description: 'Per-symbol complexity: branches, cyclomatic estimate, fan-in/out, callees',
    options: [option('--full', 'Run unbounded semantic analysis on large indexes')],
    budget: 'semantic',
    renderShape: 'custom',
    docs: doc('Health'),
    handler: handleComplexity,
  },
];
