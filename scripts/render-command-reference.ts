import { commandDescriptors } from '../src/runtime/command-descriptors.js';
import { renderCommandReferenceMarkdown } from '../src/runtime/command-docs.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
