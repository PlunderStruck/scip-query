import { describe, expect, it } from 'vitest';
import { GRAPH_EVIDENCE_FAMILIES } from '../../src/domain/graph-exploration-contract.js';
import { commandDescriptors } from '../../src/runtime/commands/command-descriptors.js';
import {
  explorationControlManualRows,
  explorationRelationshipManualRows,
  renderExplorationManualMarkdown,
} from '../../src/runtime/command-kit/exploration-manual.js';

describe('exploration manual', () => {
  it('derives the six primary controls from executable command contracts', () => {
    const rows = explorationControlManualRows(commandDescriptors);

    expect(rows.map((row) => row.id)).toEqual(['search', 'outline', 'entrypoints', 'evidence', 'inspect', 'code']);
    for (const row of rows) {
      expect(row.requiredInput.length, row.id).toBeGreaterThan(0);
      expect(row.returnedFact.length, row.id).toBeGreaterThan(0);
      expect(row.evidenceCeiling.length, row.id).toBeGreaterThan(0);
      expect(row.nonClaim.length, row.id).toBeGreaterThan(0);
      expect(row.contrasts.length, row.id).toBeGreaterThan(0);
    }
  });

  it('covers every relationship family and both causal directions where they differ', () => {
    const rows = explorationRelationshipManualRows();

    expect(new Set(rows.map((row) => row.family))).toEqual(new Set(GRAPH_EVIDENCE_FAMILIES));
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ family: 'execution', direction: 'incoming' }),
        expect.objectContaining({ family: 'execution', direction: 'outgoing' }),
        expect.objectContaining({ family: 'dataflow', direction: 'incoming' }),
        expect.objectContaining({ family: 'dataflow', direction: 'outgoing' }),
      ]),
    );
    for (const row of rows) {
      expect(row.evidenceStrengths.length, `${row.family}/${row.direction}`).toBeGreaterThan(0);
      expect(row.supportCeilings.length, `${row.family}/${row.direction}`).toBeGreaterThan(0);
    }
  });

  it('renders the complete decision contract rather than inferred task guidance', () => {
    const markdown = renderExplorationManualMarkdown(commandDescriptors);

    expect(markdown).toContain('Required input');
    expect(markdown).toContain('Evidence ceiling');
    expect(markdown).toContain('Does not establish');
    expect(markdown).toContain('Provider ceilings');
    expect(markdown).toContain('Evidence strength legend');
    expect(markdown).toContain('no calibrated evidence strength');
    expect(markdown).toContain('Who can call or reach this?');
    expect(markdown).not.toContain('recommended next');
    expect(markdown).not.toContain('task relevance score');
  });
});
