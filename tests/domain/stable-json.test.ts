import { describe, expect, it } from 'vitest';

import { codeUnitStableJson, stableJson } from '../../src/domain/stable-json.js';

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

  it('can order process-local identity keys without locale collation', () => {
    expect(codeUnitStableJson({ a: { z: 1, b: 2 }, B: true })).toBe('{"B":true,"a":{"b":2,"z":1}}');
  });
});
