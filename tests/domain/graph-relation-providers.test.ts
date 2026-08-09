import { describe, expect, it } from 'vitest';
import { GRAPH_EVIDENCE_FAMILIES } from '../../src/domain/graph-exploration-contract.js';
import { GRAPH_RELATION_CONTRACTS } from '../../src/domain/graph-relation-contracts.js';
import {
  GRAPH_RELATION_PROVIDER_CONTRACTS,
  GRAPH_RELATION_UNAVAILABLE_FRONTIERS,
  graphRelationUnavailableFrontiersFor,
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
        expect(relation.nonClaims.length, `${relation.family}/${exampleSubtype}`).toBeGreaterThan(0);
        expect(relation.recoverWith.length, `${relation.family}/${exampleSubtype}`).toBeGreaterThan(0);
        if (relation.supportCeiling === 'exact') {
          expect(relation.evidenceStrengths, `${relation.family}/${exampleSubtype}`).not.toContain('candidate');
        }
        if (relation.supportCeiling === 'candidate') {
          expect(relation.evidenceStrengths, `${relation.family}/${exampleSubtype}`).toEqual(['candidate']);
        }
      }
    }
  });

  it('keeps provider matchers non-overlapping for every registered family and subtype', () => {
    const relations = GRAPH_RELATION_PROVIDER_CONTRACTS.flatMap((provider) => provider.relations);
    for (const [index, left] of relations.entries()) {
      for (const right of relations.slice(index + 1)) {
        if (left.family !== right.family) continue;
        const leftExample = left.match === 'prefix' ? `${left.subtype}fixture` : left.subtype;
        const rightExample = right.match === 'prefix' ? `${right.subtype}fixture` : right.subtype;
        expect(
          matches(left, rightExample) || matches(right, leftExample),
          `${left.family}/${left.subtype} overlaps ${right.family}/${right.subtype}`,
        ).toBe(false);
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

  it('declares every known unavailable analysis as an explicit non-lexical frontier', () => {
    expect(GRAPH_RELATION_UNAVAILABLE_FRONTIERS.map((frontier) => frontier.id)).toEqual([
      'general-interprocedural-value-flow',
      'heap-aliasing',
      'exceptional-flow',
      'reflection',
      'generated-dispatch',
      'unsupported-framework-adapters',
    ]);
    for (const frontier of GRAPH_RELATION_UNAVAILABLE_FRONTIERS) {
      expect(frontier.families.length, frontier.id).toBeGreaterThan(0);
      expect(frontier.capability.trim(), frontier.id).not.toBe('');
      expect(frontier.consequence.trim(), frontier.id).not.toBe('');
      expect(frontier.recoverWith.length, frontier.id).toBeGreaterThan(0);
      expect(frontier.recoverWith, frontier.id).not.toContain('similar');
      expect(frontier.recoverWith, frontier.id).not.toContain('anchors');
    }
    expect(graphRelationUnavailableFrontiersFor(['identity']).map((frontier) => frontier.id)).toEqual([
      'reflection',
      'generated-dispatch',
    ]);
  });
});

function matches(
  relation: (typeof GRAPH_RELATION_PROVIDER_CONTRACTS)[number]['relations'][number],
  subtype: string,
): boolean {
  return relation.match === 'prefix' ? subtype.startsWith(relation.subtype) : subtype === relation.subtype;
}
