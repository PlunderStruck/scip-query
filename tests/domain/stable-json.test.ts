import { describe, expect, it } from 'vitest';

import { stableJson } from '../../src/domain/stable-json.js';

describe('stableJson', () => {
  it('converges equal nested objects regardless of insertion order', () => {
    expect(
      stableJson({
        z: { second: 2, first: 1 },
        a: 'value',
      }),
    ).toBe(
      stableJson({
        a: 'value',
        z: { first: 1, second: 2 },
      }),
    );
  });

  it('retains array order because it is part of logical identity', () => {
    expect(stableJson({ values: ['first', 'second'] })).not.toBe(stableJson({ values: ['second', 'first'] }));
  });

  it('uses JSON scalar encoding', () => {
    expect(stableJson({ escaped: 'a\n"b"', enabled: true, count: 2, empty: null })).toBe(
      '{"count":2,"empty":null,"enabled":true,"escaped":"a\\n\\"b\\""}',
    );
  });
});
