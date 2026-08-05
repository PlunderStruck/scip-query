import { classifyFile } from '../../source/primitives/file-kind.js';
import type { BoundarySourceScope } from './types.js';

/** Classify the evidence surface without treating non-production source as absent. */
export function runtimeBoundarySourceScope(file: string): BoundarySourceScope {
  const normalized = file.replaceAll('\\', '/');
  if (classifyFile(normalized) === 'test') {
    if (/(?:^|\/)__fixtures__\//iu.test(normalized)) return 'fixture';
    return 'test';
  }
  if (/(?:^|\/)(?:fixtures?|testdata)\//iu.test(normalized)) return 'fixture';
  if (/(?:^|\/)(?:examples?|demos?|previews?)\//iu.test(normalized)) return 'example';
  if (/(?:^|\/)(?:generated|dist|build|coverage)\//iu.test(normalized) || /\.generated\./iu.test(normalized)) {
    return 'generated';
  }
  if (/(?:^|\/)(?:scripts?|tools?)\//iu.test(normalized)) return 'script';
  return 'production';
}
