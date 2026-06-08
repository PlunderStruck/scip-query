import { commandDescriptors } from '../src/runtime/command-descriptors.js';
import { renderCommandReferenceMarkdown } from '../src/runtime/command-docs.js';

console.log(renderCommandReferenceMarkdown(commandDescriptors));
