import assert from 'node:assert/strict';
import * as desk from '../build/index.js';

assert.equal(desk.checkoutQuote(10.25, 2), 20.5);
assert.equal(desk.supportQuote(10.25, 2), 20.5);
assert.equal(desk.refundFee(100), 2);
assert.equal(desk.webShippingQuote(2), 14);
assert.deepEqual(
  desk.cancelFromWeb({ id: 'past', status: 'confirmed', startsAt: 0, locked: false }, 1, { cancelled: [], audit: [] }),
  { ok: false },
);
console.log('Existing smoke checks passed.');
