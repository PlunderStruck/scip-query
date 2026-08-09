import { describe, expect, it } from 'vitest';
import { repositoryContext } from '../../../src/queries/impact/context.js';
import { planContext } from '../../../src/queries/impact/plan-context.js';

describe('plan-context compatibility', () => {
  it('preserves the former function as an exact alias of repositoryContext', () => {
    expect(planContext).toBe(repositoryContext);
  });
});
