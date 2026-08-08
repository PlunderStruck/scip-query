import { describe, expect, it } from 'vitest';
import { GRAPH_EVIDENCE_FAMILIES } from '../../src/domain/graph-exploration-contract.js';
import { GRAPH_RELATION_CONTRACTS } from '../../src/domain/graph-relation-contracts.js';
import {
  GRAPH_RELATION_PROVIDER_CONTRACTS,
  graphRelationProviderFor,
} from '../../src/domain/graph-relation-providers.js';

describe('graph relation provider contracts', () => {
  it('resolves every declared subtype back to one concrete provider', () => {
    const providerIds = GRAPH_RELATION_PROVIDER_CONTRACTS.map((provider) => provider.id);
    expect(new Set(providerIds).size).toBe(providerIds.length);

    for (const provider of GRAPH_RELATION_PROVIDER_CONTRACTS) {
      expect(provider.requirements.length, provider.id).toBeGreaterThan(0);
      for (const relation of provider.relations) {
        const exampleSubtype = relation.match === 'prefix' ? `${relation.subtype}fixture` : relation.subtype;
        const resolved = graphRelationProviderFor(relation.family, exampleSubtype);
        expect(resolved?.provider.id, `${relation.family}/${exampleSubtype}`).toBe(provider.id);
        expect(resolved?.relation).toBe(relation);
        expect(relation.directions.length).toBeGreaterThan(0);
        expect(relation.evidenceStrengths.length).toBeGreaterThan(0);
        expect(relation.establishes.trim()).not.toBe('');
      }
    }
  });

  it('keeps every public relationship family connected to provider-owned subtype contracts', () => {
    const providerFamilies = new Set(
      GRAPH_RELATION_PROVIDER_CONTRACTS.flatMap((provider) => provider.relations.map((relation) => relation.family)),
    );

    expect([...providerFamilies].sort()).toEqual([...GRAPH_EVIDENCE_FAMILIES].sort());
    expect(GRAPH_RELATION_CONTRACTS.map((contract) => contract.family)).toEqual(GRAPH_EVIDENCE_FAMILIES);
    for (const contract of GRAPH_RELATION_CONTRACTS) {
      expect(contract.relations.length, contract.family).toBeGreaterThan(0);
      expect(contract.providers.length, contract.family).toBeGreaterThan(0);
    }
  });
});
