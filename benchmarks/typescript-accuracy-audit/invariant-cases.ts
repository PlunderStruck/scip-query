import { cases, type AuditCase } from './cases.js';

// These transformations preserve the behavior of the four chosen closed programs.
// They deliberately change source positions and identifier encodings.
const transforms: Array<[string, (source: string) => string]> = [
  ['blank-lines', (source) => '\n// audit layout\n' + source.replaceAll('\n', '\n\n')],
  ['crlf', (source) => source.replaceAll('\n', '\r\n')],
  ['ascii-rename', (source) => source.replaceAll('original', 'firstCallable').replaceAll('service', 'subject')],
  ['bmp-rename', (source) => source.replaceAll('original', 'origine').replaceAll('service', 'sérvice')],
  ['astral-rename', (source) => source.replaceAll('original', '𝒇').replaceAll('service', '𝒔')],
  [
    'astral-comments',
    (source) =>
      source
        .split('\n')
        .map((line) => '/* 🧭 */ ' + line)
        .join('\n'),
  ],
];

export const invariantCases: AuditCase[] = cases
  .filter((item) => ['direct-call', 'sibling-write', 'helper-parameter-write', 'field-function'].includes(item.id))
  .flatMap((item) =>
    transforms.map(([name, transform]) => ({
      ...item,
      id: `invariant-${item.id}-${name}`,
      area: 'invariants',
      source: transform(item.source),
      interpretation: `Meaning-preserving ${name} transformation of ${item.id}; compare to its recorded baseline.`,
    })),
  );
