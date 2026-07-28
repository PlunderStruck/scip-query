import { describe, expect, it } from 'vitest';
import { decodeSemanticAvailability } from '../../src/semantic/types.js';

describe('semantic availability contract', () => {
  it('requires a reason exactly when semantic evidence is unavailable', () => {
    expect(decodeSemanticAvailability({ available: true, resolvedBinary: '/bin/rust-analyzer' })).toEqual({
      available: true,
      resolvedBinary: '/bin/rust-analyzer',
    });
    expect(decodeSemanticAvailability({ available: false, reason: 'provider offline' })).toEqual({
      available: false,
      reason: 'provider offline',
    });
    expect(decodeSemanticAvailability({ available: false })).toBeNull();
    expect(decodeSemanticAvailability({ available: false, reason: '' })).toBeNull();
    expect(decodeSemanticAvailability({ available: true, reason: 'failure in a success state' })).toBeNull();
  });
});
