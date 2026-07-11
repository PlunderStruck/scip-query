import { afterEach, describe, expect, it } from 'vitest';
import { shouldUseVueWorkers } from '../../src/reindex/vue/augment-vue-workers.js';

const originalWorkerCount = process.env['SCIP_QUERY_AUGMENT_VUE_WORKERS'];

afterEach(() => {
  if (originalWorkerCount === undefined) {
    delete process.env['SCIP_QUERY_AUGMENT_VUE_WORKERS'];
  } else {
    process.env['SCIP_QUERY_AUGMENT_VUE_WORKERS'] = originalWorkerCount;
  }
});

describe('Vue reference worker policy', () => {
  it('uses the reliable single-context path by default', () => {
    delete process.env['SCIP_QUERY_AUGMENT_VUE_WORKERS'];

    expect(shouldUseVueWorkers(Array.from({ length: 500 }, (_, index) => `View${index}.vue`))).toBe(false);
  });

  it('keeps parallel workers available as an explicit opt-in', () => {
    process.env['SCIP_QUERY_AUGMENT_VUE_WORKERS'] = '2';

    expect(shouldUseVueWorkers(Array.from({ length: 8 }, (_, index) => `View${index}.vue`))).toBe(true);
  });
});
