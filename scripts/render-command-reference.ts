import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commandDescriptors } from '../src/runtime/commands/command-descriptors.js';
import { renderCommandReferenceMarkdown } from '../src/runtime/commands/command-docs.js';

const generated = renderCommandReferenceMarkdown(commandDescriptors);

if (process.argv.includes('--write')) {
  const path = join(process.cwd(), 'docs/COMMAND_REFERENCE.md');
  const content = readFileSync(path, 'utf8');
  writeFileSync(
    path,
    content.replace(
      /<!-- BEGIN GENERATED COMMAND REFERENCE -->[\s\S]*?<!-- END GENERATED COMMAND REFERENCE -->/,
      generated,
    ),
  );
} else {
  console.log(generated);
}
