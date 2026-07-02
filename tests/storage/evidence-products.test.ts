import { describe, expect, it } from 'vitest';
import { EVIDENCE_PRODUCT_MANIFEST, validateEvidenceProductManifest } from '../../src/storage/evidence-products.js';

describe('evidence product manifest', () => {
  it('has exactly one manifest entry for every cache kind', () => {
    expect(validateEvidenceProductManifest()).toEqual({ missing: [], duplicate: [], unknown: [] });
  });

  it('reports missing, duplicate, and unknown manifest entries', () => {
    const manifest = [
      ...EVIDENCE_PRODUCT_MANIFEST.filter(
        (entry) => !(entry.scope === 'project' && entry.kind === 'file-dependency-graph'),
      ),
      EVIDENCE_PRODUCT_MANIFEST[0]!,
      EVIDENCE_PRODUCT_MANIFEST[0]!,
      {
        scope: 'file',
        kind: 'not-real',
        invalidation: EVIDENCE_PRODUCT_MANIFEST[0]!.invalidation,
      },
    ] as typeof EVIDENCE_PRODUCT_MANIFEST;

    expect(validateEvidenceProductManifest(manifest)).toEqual({
      missing: ['project:file-dependency-graph'],
      duplicate: ['file:source-facts'],
      unknown: ['file:not-real'],
    });
  });

  it('records owner, key parts, and staleness test for every product', () => {
    for (const entry of EVIDENCE_PRODUCT_MANIFEST) {
      expect(entry.invalidation.owner).toMatch(/^src\/|^tests\//);
      expect(entry.invalidation.keyParts.length).toBeGreaterThan(0);
      expect(entry.invalidation.dependsOn.length).toBeGreaterThan(0);
      expect(entry.invalidation.stalenessTest).toMatch(/^tests\//);
    }
  });
});
