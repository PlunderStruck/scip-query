import assert from 'node:assert/strict';
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Run in a fresh process against independently compiled submitted source. These
// checks live outside the agent checkout and do not import its test runner.
export async function checkBehavior(build, task, phase) {
  const api = await import(pathToFileURL(join(build, 'index.js')).href);
  const results = [];
  const check = (id, category, run) => {
    try {
      run();
      results.push({ id, category, pass: true });
    } catch (error) {
      results.push({ id, category, pass: false, detail: error.message });
    }
  };
  const observedStore = (keys, owner) => {
    const writes = [];
    const record = () => {
      const stack = new Error().stack ?? '';
      writes.push(
        stack.replaceAll('\\', '/').includes(`${build.replaceAll('\\', '/')}/${owner}/`) ||
          stack.includes(`${pathToFileURL(join(build, owner)).href}/`),
      );
    };
    const value = Object.fromEntries(
      keys.map((key) => [
        key,
        new Proxy([], {
          set(target, property, item) {
            if (property !== 'length') record();
            return Reflect.set(target, property, item);
          },
        }),
      ]),
    );
    return {
      writes,
      store: new Proxy(value, {
        set(target, key, item) {
          record();
          return Reflect.set(target, key, item);
        },
      }),
    };
  };
  check('existing-public-behavior', 'behavior', () => {
    assert.equal(api.checkoutQuote(10.25, 2), 20.5);
    assert.equal(api.supportQuote(10.25, 2), 20.5);
    assert.equal(api.refundFee(100), 2);
    assert.equal(api.webShippingQuote(2), 14);
    assert.equal(api.settings.receiptRetryLimit, 3);
    for (const name of [
      'canCancel',
      'cancelReservation',
      'cancelFromWeb',
      'cancelFromJob',
      'cancelFromAdmin',
      'sendReceipt',
    ]) {
      assert.equal(typeof api[name], 'function', `${name} remains public`);
    }
    assert.equal(api.chargeFee(100), task === 'separate-responsibilities' && phase === 'follow-up' ? 3 : 2);
  });
  if (task === 'shared-rule') {
    const window = (phase === 'follow-up' ? 48 : 24) * 60 * 60 * 1000;
    const now = 100_000;
    const channels = [
      ['web', (r, s) => api.cancelFromWeb(r, now, s).ok],
      ['admin', (r, s) => api.cancelFromAdmin(r, now, s)],
      ['job', (r, s) => api.cancelFromJob(r, now, s)],
      ['owner', (r, s) => api.cancelReservation(r, now, s)],
    ];
    for (const [channel, cancel] of channels) {
      check(`cancellation-${channel}`, 'behavior', () => {
        for (const status of ['pending', 'confirmed', 'cancelled']) {
          for (const locked of [false, true]) {
            for (const offset of [-1, 0, 1, window - 1, window, window + 1]) {
              const reservation = {
                id: `${channel}-${status}-${locked}-${offset}`,
                status,
                locked,
                startsAt: now + offset,
              };
              const store = { cancelled: [], audit: [] };
              const expected = status === 'confirmed' && !locked && offset >= window;
              assert.equal(api.canCancel(reservation, now), expected, 'public eligibility agrees');
              assert.equal(cancel(reservation, store), expected, JSON.stringify(reservation));
              assert.deepEqual(store.cancelled, expected ? [reservation.id] : []);
              assert.deepEqual(
                store.audit,
                expected ? [{ kind: 'reservation.cancelled', reservationId: reservation.id }] : [],
              );
            }
          }
        }
      });
    }
    check('cancellation-write-owner', 'ownership', () => {
      for (const [, cancel] of channels) {
        const { store, writes } = observedStore(['cancelled', 'audit'], 'reservations');
        cancel({ id: 'owned', status: 'confirmed', locked: false, startsAt: now + window }, store);
        assert.equal(
          writes.length > 0 && writes.every(Boolean),
          true,
          'Cancellation writes must occur while the reservation owner is executing.',
        );
      }
    });
  }
  if (task === 'separate-responsibilities') {
    check('quote-behavior', 'behavior', () => {
      for (const price of [0, 0.105, 1.235, 12.99, 140.25]) {
        for (const quantity of [0, 1, 3, 11]) {
          for (const discount of phase === 'follow-up' ? [0, 10, 25, 100] : [0]) {
            const expected = Math.round(price * quantity * (1 - discount / 100) * 100) / 100;
            assert.equal(api.checkoutQuote(price, quantity, discount), expected);
            assert.equal(api.supportQuote(price, quantity, discount), expected);
          }
        }
      }
    });
    check('independent-fee-policies', 'behavior', () => {
      for (const amount of [0, 1, 25, 50, 100, 250, 999]) {
        assert.equal(
          api.chargeFee(amount),
          phase === 'follow-up' ? Math.max(2, Math.round(amount * 0.03)) : Math.max(1, Math.round(amount * 0.02)),
        );
        assert.equal(api.refundFee(amount), Math.max(1, Math.round(amount * 0.02)));
      }
    });
  }
  if (task === 'retire-implementation') {
    for (const [channel, send] of [
      ['route', api.receiptRoutes.receipt],
      ['job', api.receiptJobs.receipt],
    ]) {
      check(`receipt-${channel}`, 'behavior', () => {
        const store = { events: [] };
        send({ id: 'order-a', email: 'a@example.test' }, store);
        assert.deepEqual(store.events, [
          { kind: 'receipt.sent', orderId: 'order-a', to: 'a@example.test', transport: 'v2' },
        ]);
      });
      check(`receipt-${channel}-write-owner`, 'ownership', () => {
        const { store, writes } = observedStore(['events'], 'notifications');
        send({ id: `owned-${channel}`, email: 'owner@example.test' }, store);
        assert.equal(
          writes.length > 0 && writes.every(Boolean),
          true,
          'Receipt writes must execute through the notification owner.',
        );
      });
    }
    if (phase === 'follow-up') {
      check('deduplication-and-store-lifetime', 'behavior', () => {
        const first = { events: [] };
        const second = { events: [] };
        const order = { id: 'shared-order', email: 'shared@example.test' };
        api.receiptRoutes.receipt(order, first);
        api.receiptJobs.receipt(order, first);
        api.receiptRoutes.receipt(order, first);
        api.receiptJobs.receipt({ id: 'another-order', email: 'other@example.test' }, first);
        api.receiptRoutes.receipt(order, second);
        api.receiptJobs.receipt(order, second);
        assert.deepEqual(
          first.events.map((event) => event.orderId),
          ['shared-order', 'another-order'],
        );
        assert.deepEqual(
          second.events.map((event) => event.orderId),
          ['shared-order'],
        );
        assert.equal(
          first.events.every((event) => event.kind === 'receipt.sent' && event.transport === 'v2'),
          true,
        );
      });
    }
  }
  if (task === 'dependency-direction') {
    check('caller-supplied-shipping-rate', 'behavior', () => {
      for (const weight of [0, 1, 2.5, 10]) {
        for (const rate of [0, 2, 7, 11]) assert.equal(api.shippingCost(weight, rate), weight * rate);
      }
    });
    if (phase === 'follow-up') {
      check('independent-shipping-callers', 'behavior', () => {
        for (const rate of [0, 2, 11, 3]) {
          assert.equal(api.batchShippingQuote(3, rate), 3 * rate);
          assert.equal(api.webShippingQuote(3), 21);
        }
      });
    }
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  process.stdout.write(JSON.stringify(await checkBehavior(input.build, input.task, input.phase)));
}
