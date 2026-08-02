import { describe, expect, it } from 'vitest';

import { isMonotonicArchitecturePolicyTightening } from '../../src/change-control/architecture-policy-authority.js';

describe('monotonic architecture-policy authority', () => {
  const predecessor = {
    schemaVersion: 2,
    collaborationDomainId: 'project',
    watch: { enabled: true },
    architecture: {
      boundaries: [
        { name: 'worker', paths: ['src/worker/**'] },
        { name: 'configuration', paths: ['src/config/**'] },
      ],
      allowedDependencies: {
        worker: ['configuration', 'domain'],
        configuration: ['domain'],
      },
      requireCompletePolicy: true,
    },
  };

  it('accepts an edit that only removes dependency permissions', () => {
    const successor = structuredClone(predecessor);
    successor.architecture.allowedDependencies.worker = ['domain'];

    expect(tightening(successor)).toBe(true);
  });

  it.each([
    [
      'adds a dependency permission',
      (successor: typeof predecessor) => successor.architecture.allowedDependencies.configuration.push('worker'),
    ],
    [
      'removes a dependency-row owner',
      (successor: typeof predecessor) => delete successor.architecture.allowedDependencies.configuration,
    ],
    [
      'changes a boundary',
      (successor: typeof predecessor) => successor.architecture.boundaries[0]!.paths.push('src/shared/**'),
    ],
    [
      'weakens an architecture switch',
      (successor: typeof predecessor) => {
        successor.architecture.requireCompletePolicy = false;
      },
    ],
    [
      'changes unrelated configuration',
      (successor: typeof predecessor) => {
        successor.watch.enabled = false;
      },
    ],
  ])('rejects an edit that %s', (_name, mutate) => {
    const successor = structuredClone(predecessor);
    mutate(successor);

    expect(tightening(successor)).toBe(false);
  });

  it('rejects invalid and no-op configurations', () => {
    expect(isMonotonicArchitecturePolicyTightening('{', JSON.stringify(predecessor))).toBe(false);
    expect(tightening(structuredClone(predecessor))).toBe(false);
  });

  function tightening(successor: unknown): boolean {
    return isMonotonicArchitecturePolicyTightening(JSON.stringify(predecessor), JSON.stringify(successor));
  }
});
