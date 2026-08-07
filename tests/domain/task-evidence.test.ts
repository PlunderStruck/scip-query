import { describe, expect, it } from 'vitest';
import { createTaskEvidenceContract } from '../../src/domain/task-evidence.js';

describe('task evidence contract', () => {
  it('keeps the original task and exposes every universal exploration obligation without claiming completion', () => {
    const contract = createTaskEvidenceContract('  Explain how compaction works end to end.  ');

    expect(contract.task).toBe('Explain how compaction works end to end.');
    expect(contract.assessmentAuthority).toBe('agent');
    expect(contract.obligations.map((obligation) => obligation.id)).toEqual([
      'scope',
      'entry',
      'guards',
      'transformations',
      'effects',
      'boundaries',
      'outputs',
      'failures',
      'recovery',
      'variants',
    ]);
    expect(contract.obligations.every((obligation) => obligation.disposition === 'unassessed')).toBe(true);
    expect(contract.completionRule).toContain('graph presence alone never establishes task relevance');
  });

  it('returns independent obligation records and rejects a missing task', () => {
    const first = createTaskEvidenceContract('Explain the first system.');
    const second = createTaskEvidenceContract('Explain the second system.');

    expect(first.obligations).not.toBe(second.obligations);
    expect(first.obligations[0]).not.toBe(second.obligations[0]);
    expect(() => createTaskEvidenceContract('   ')).toThrow('requires the original repository question');
  });
});
