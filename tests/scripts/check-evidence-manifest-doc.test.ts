import { describe, expect, it } from 'vitest';
import { checkEvidenceManifestDoc, manifestKeys } from '../../scripts/check-evidence-manifest-doc.mjs';

describe('evidence manifest doc checker', () => {
  it('extracts manifest keys from product declarations', () => {
    expect(
      manifestKeys(`
        fileManifest('source-facts', {});
        projectManifest('file-dependency-graph', {});
        fileManifest('source-facts', {});
      `),
    ).toEqual(['file:source-facts', 'project:file-dependency-graph']);
  });

  it('requires every manifest entry to appear with a staleness test path', () => {
    const sourceText = `
      fileManifest('source-facts', {});
      projectManifest('file-dependency-graph', {});
    `;
    const docText = `
| Product | Test |
| --- | --- |
| \`file:source-facts\` | \`tests/storage/evidence-cache.test.ts\` |
`;

    expect(checkEvidenceManifestDoc({ sourceText, docText })).toEqual({
      ok: false,
      missing: ['project:file-dependency-graph'],
      missingStalenessTest: [],
    });
  });
});
