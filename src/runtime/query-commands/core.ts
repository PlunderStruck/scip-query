import * as queries from '../../queries/index.js';
import type { CommandDescriptor } from '../command-kit/command-descriptor-types.js';
import { analysisAgentContract, doc, withJsonOption } from '../command-kit/command-spec-builders.js';
import { booleanOptionValue, dbCommand, printJsonEnvelope } from '../command-kit/command-execution.js';
import { formatBytes } from '../cli-context.js';

const handleStats = dbCommand(({ db, args, opts }) => {
  const s = queries.stats(db);
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('stats', args, opts, s);
    return;
  }
  console.log(`Documents:   ${s.documents}`);
  console.log(`Symbols:     ${s.symbols}`);
  console.log(`Definitions: ${s.definitions}`);
  console.log(`References:  ${s.references}`);
  console.log(`Index size:  ${formatBytes(s.indexSizeBytes)}`);
  if (s.lastBuilt) {
    console.log(`Last built:  ${s.lastBuilt.toISOString().replace('T', ' ').slice(0, 19)}`);
  }
});

export const coreQueryCommandDescriptors: CommandDescriptor[] = [
  {
    id: 'stats',
    command: 'stats',
    description: 'Show index statistics',
    agent: analysisAgentContract(
      'How large and fresh is the current index?',
      'document, symbol, definition, reference, size, and build-time totals',
      [],
      'complete',
      'repository',
    ),
    options: withJsonOption(),
    renderShape: 'custom',
    docs: doc('Core'),
    handler: handleStats,
  },
];
