import type { CommandDescriptor } from '../command-kit/command-descriptor-types.js';
import { continueCliOutput } from '../output-pagination.js';
import { cliVersion } from '../cli-support.js';

async function handleOutputContinuation(cursor: unknown): Promise<void> {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    throw new Error('Output continuation requires a cursor.');
  }
  await continueCliOutput(cursor, cliVersion);
}

export const outputContinuationCommandDescriptor: CommandDescriptor = {
  id: 'continue',
  command: 'continue <cursor>',
  hidden: true,
  description: 'Continue an immutable output snapshot',
  renderShape: 'custom',
  handler: handleOutputContinuation,
};
