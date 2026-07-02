import { describe, expect, it } from 'vitest';
import { markdownCitationContext } from '../../../src/queries/cleanup/doc-citation-context.js';

describe('doc citation context', () => {
  it('returns the containing fenced code block for a cited path inside a code example', () => {
    const lines = ['Intro', '', '```json', '{ "files": ["src/a.ts"] }', '```', '', 'After'];

    expect(markdownCitationContext(lines, 3)).toBe('```json\n{ "files": ["src/a.ts"] }\n```');
  });

  it('keeps nested list item context together', () => {
    const lines = [
      '- Update docs',
      '  - Check src/a.ts after changing behavior',
      '  - Keep examples fresh',
      '',
      'Next',
    ];

    expect(markdownCitationContext(lines, 1)).toContain('Check src/a.ts');
  });
});
