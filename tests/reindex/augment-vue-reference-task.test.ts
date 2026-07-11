import { describe, expect, it, vi } from 'vitest';
import { computeVueReferenceTask, type VueReferenceComputationOptions } from '../../src/reindex/vue/augment-vue.js';

describe('Vue reference task computation', () => {
  it('counts a missing project file as skipped before asking Volar to load it', () => {
    const getSourceScript = vi.fn(() => {
      throw new Error('Volar must not load a source file that does not exist');
    });
    const options = {
      sourceReader: { get: vi.fn(() => null) },
      context: { language: { scripts: { get: getSourceScript } } },
    } as unknown as VueReferenceComputationOptions;

    expect(
      computeVueReferenceTask(options, {
        fileName: '/project/src/MissingView.vue',
        startOffset: 0,
        endOffset: Number.POSITIVE_INFINITY,
        countFileSkip: true,
      }),
    ).toEqual({ occurrences: [], skippedReferences: 1 });
    expect(getSourceScript).not.toHaveBeenCalled();
  });
});
