import * as queries from '../../queries/index.js';
import type { CommandDescriptor } from '../commands/command-descriptor-types.js';
import { doc, option, parseInteger, withJsonOption } from '../commands/command-spec-builders.js';
import {
  booleanOptionValue,
  budgetedDbCommand,
  dbCommand,
  definedNumberOption,
  printJsonEnvelope,
  stringArg,
  stringOptionValue,
} from '../commands/command-execution.js';
import { displayPathRange, render } from '../render.js';
import { symbolResolutionBefore, symbolResolutionEmptyMessage, withSymbolResolutionJson } from './symbol-resolution.js';

const handleComplexity = budgetedDbCommand('complexity', ({ db, args, opts, budget }) => {
  const query = stringArg(args, 0);
  const result = queries.complexity(db, query, { semantic: budget.semantic });
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('complexity', args, opts, withSymbolResolutionJson(db, query, result, 'complexity'));
    return;
  }
  if (!result) return render.empty(symbolResolutionEmptyMessage(db, query, 'Symbol not found.'));
  symbolResolutionBefore(db, query);
  console.log(`${displayPathRange(result.relativePath, result.startLine, result.endLine)}  ${result.shortName}\n`);
  console.log(`  LOC:                  ${result.loc}`);
  console.log(`  Branches:             ${result.branches}`);
  console.log(`  Cyclomatic estimate:  ${result.cyclomaticEstimate}`);
  console.log(`  Callees:              ${result.calleeCount}`);
  console.log(`  Fan-in:               ${result.fanIn}`);
  console.log(`  Fan-out:              ${result.fanOut}`);
});

const handleSelfAudit = dbCommand(({ db, args, opts }) => {
  const result = queries.selfAudit(db, {
    samples: definedNumberOption(opts, 'samples', 50),
    scope: stringOptionValue(opts, 'scope'),
  });
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('self-audit', args, opts, result);
    return;
  }
  if (!result.available) {
    return render.empty('No semantic or source-backed oracle available to audit against.');
  }
  const oracleLabel = result.oracleKind === 'source' ? 'source facts' : 'compiler semantics';
  console.log(
    `Sampled ${result.sampleSize} symbols; ${oracleLabel} oracle answered ${Math.round(result.oracleCoverage * 100)}%.\n`,
  );
  console.log(`Agreement with ${oracleLabel} (file-level):`);
  for (const score of result.scores) {
    const precision =
      score.precision === null
        ? `unverified ${score.unverified} (oracle partial — no precision claim)`
        : `precision ${score.precision}`;
    console.log(
      `  ${score.question.padEnd(11)} ${precision}  recall ${score.recall}  (${score.comparedSymbols} compared, ${score.skippedOraclePartial} skipped: oracle-partial)`,
    );
  }
  if (result.topDisagreements.length > 0) {
    console.log('\nTop disagreements (debugging targets):');
    for (const entry of result.topDisagreements) {
      console.log(`  ${entry.symbol}  [${entry.question}]`);
      if (entry.cheapOnly.length > 0) console.log(`    cheap-only:  ${entry.cheapOnly.join(', ')}`);
      if (entry.oracleOnly.length > 0) console.log(`    oracle-only: ${entry.oracleOnly.join(', ')}`);
    }
  }
});

export const healthQueryCommandDescriptors: CommandDescriptor[] = [
  {
    id: 'self-audit',
    command: 'self-audit',
    description: 'Score cheap evidence paths against the best available semantic/source oracle on sampled symbols',
    options: withJsonOption([
      option('--samples <n>', 'Number of symbols to sample', parseInteger, 50),
      option('-s, --scope <path>', 'Limit sampling to files matching path'),
    ]),
    renderShape: 'custom',
    docs: doc('Health', ['scip-query self-audit --samples 100']),
    handler: handleSelfAudit,
  },
  {
    id: 'complexity',
    command: 'complexity <symbol>',
    description: 'Per-symbol complexity: branches, cyclomatic estimate, fan-in/out, callees',
    options: withJsonOption([option('--full', 'Run unbounded semantic analysis on large indexes')]),
    budget: 'semantic',
    renderShape: 'custom',
    docs: doc('Health'),
    handler: handleComplexity,
  },
];
