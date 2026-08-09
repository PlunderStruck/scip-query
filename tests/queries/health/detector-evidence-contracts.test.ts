import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DETECTOR_EVIDENCE_CONTRACTS,
  assessDetectorEvidenceContracts,
  renderDetectorEvidenceContractsMarkdown,
} from '../../../src/queries/health/detector-evidence-contracts.js';

describe('health detector evidence contracts', () => {
  it('maps every graph requirement to a registered provider and discloses partial claims', () => {
    const assessed = assessDetectorEvidenceContracts();
    expect(assessed).toHaveLength(DETECTOR_EVIDENCE_CONTRACTS.length);
    expect(new Set(assessed.map((row) => row.id)).size).toBe(assessed.length);
    expect(assessed.every((row) => row.nonClaims.length > 0 && row.recoverWith.startsWith('scip-query '))).toBe(true);
    expect(assessed.find((row) => row.id === 'dead-visible-references')).toEqual(
      expect.objectContaining({ status: 'mixed', providerCoverage: 'partial' }),
    );
    expect(assessed.find((row) => row.id === 'duplicate-structural-candidate')?.providerIds).toEqual([]);
  });

  it('reports missing provider requirements as unsupported rather than as negative evidence', () => {
    const assessed = assessDetectorEvidenceContracts(new Set());
    expect(assessed.find((row) => row.id === 'isolated-visible-connectivity')).toEqual(
      expect.objectContaining({ status: 'unsupported', unavailableRequirements: ['indexed-graph'] }),
    );
    expect(assessed.find((row) => row.id === 'duplicate-structural-candidate')?.status).toBe('candidate');
  });

  it('keeps generated detector documentation byte-current', () => {
    expect(readFileSync(join(process.cwd(), 'docs/DETECTOR_EVIDENCE_CONTRACTS.md'), 'utf8')).toBe(
      renderDetectorEvidenceContractsMarkdown(),
    );
  });
});
