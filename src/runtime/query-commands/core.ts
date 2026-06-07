import * as queries from '../../queries/index.js';
import type { CommandDescriptor } from '../command-descriptor-types.js';
import { doc } from '../command-spec-builders.js';
import { dbCommand } from '../command-execution.js';
import { formatBytes } from '../cli-context.js';

const handleStats = dbCommand(({ db }) => {
  const s = queries.stats(db);
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
    renderShape: 'custom',
    docs: doc('Core'),
    handler: handleStats,
  },
];
