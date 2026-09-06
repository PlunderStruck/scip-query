import * as queries from '../../queries/index.js';
import type { CommandDescriptor } from '../command-kit/command-descriptor-types.js';
import { analysisAgentContract, doc, option, withJsonOption } from '../command-kit/command-spec-builders.js';
import {
  booleanOptionValue,
  budgetedDbCommand,
  printJsonEnvelope,
  stringArg,
} from '../command-kit/command-execution.js';
import { displayPathRange, render } from '../render.js';
import { symbolResolutionBefore, symbolResolutionEmptyMessage, withSymbolResolutionJson } from './symbol-resolution.js';

const handleComplexity = budgetedDbCommand('complexity', ({ db, args, opts, budget }) => {
  const query = stringArg(args, 0);
  const result = queries.complexity(db, query, { semantic: budget.semantic });
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('complexity', args, opts, withSymbolResolutionJson(db, query, result, 'complexity'), {
      analysisBudget: budget.analysisBudget,
    });
    return;
  }
  if (!result) return render.empty(symbolResolutionEmptyMessage(db, query, 'Symbol not found.'));
  symbolResolutionBefore(db, query);
  console.log(`${displayPathRange(result.relativePath, result.startLine, result.endLine)}  ${result.shortName}\n`);
  console.log(`  LOC:                  ${result.loc}`);
  console.log(`  Branches:             ${result.branches}`);
  console.log(`  Cyclomatic estimate:  ${result.cyclomaticEstimate}`);
  console.log(`  Metric rules:         ${result.metricRules}`);
  console.log(`  Callees:              ${result.calleeCount}`);
  console.log(`  Candidate targets:    ${result.candidateCalleeCount}`);
  console.log(`  Referencing files:    ${result.fanIn}`);
  console.log(`  External callees:     ${result.fanOut}`);
});

export const healthQueryCommandDescriptors: CommandDescriptor[] = [
  {
    id: 'complexity',
    command: 'complexity <symbol>',
    description: 'Per-symbol complexity: branches, cyclomatic estimate, fan-in/out, callees',
    agent: analysisAgentContract(
      'How structurally complex and connected is this symbol?',
      'LOC, branch, complexity, callee, fan-in, and fan-out counts',
      ['symbol'],
      'bounded',
    ),
    options: withJsonOption([option('--full', 'Run unbounded semantic analysis on large indexes')]),
    budget: 'semantic',
    renderShape: 'custom',
    docs: doc('Health'),
    handler: handleComplexity,
  },
];
