import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Verifier tests only. These are examples, never patches required of the agent.
export function applyReferencePatch(root, task, phase = 'initial') {
  const put = (path, text) => writeFileSync(join(root, path), `${text.trim()}\n`);
  if (task === 'shared-rule') {
    put(
      'src/reservations/policy.ts',
      `import type { Reservation } from '../domain/types.js';
export function canCancel(reservation: Reservation, now: number): boolean {
  return reservation.status === 'confirmed' && !reservation.locked && reservation.startsAt - now >= ${phase === 'follow-up' ? 48 : 24} * 60 * 60 * 1000;
}`,
    );
    put(
      'src/adapters/cancellation-job.ts',
      `import type { CancellationStore, Reservation } from '../domain/types.js';
import { cancelReservation } from '../reservations/cancel.js';
export function cancelFromJob(reservation: Reservation, now: number, store: CancellationStore): boolean {
  return cancelReservation(reservation, now, store);
}`,
    );
  }
  if (task === 'separate-responsibilities') {
    put(
      'src/pricing/quote.ts',
      `export function quote(unitPrice: number, quantity: number, discountPercent = 0): number {
  return Math.round(unitPrice * quantity * (1 - discountPercent / 100) * 100) / 100;
}`,
    );
    for (const [path, name] of [
      ['checkout-quote', 'checkoutQuote'],
      ['support-quote', 'supportQuote'],
    ]) {
      put(
        `src/adapters/${path}.ts`,
        `import { quote } from '../pricing/quote.js';
export function ${name}(unitPrice: number, quantity: number${phase === 'follow-up' ? ', discountPercent = 0' : ''}): number {
  return quote(unitPrice, quantity${phase === 'follow-up' ? ', discountPercent' : ''});
}`,
      );
    }
    if (phase === 'follow-up')
      put(
        'src/pricing/charge-fee.ts',
        'export function chargeFee(amount: number): number { return Math.max(2, Math.round(amount * 0.03)); }',
      );
  }
  if (task === 'retire-implementation') {
    for (const [path, name] of [
      ['receipt-routes', 'receiptRoutes'],
      ['receipt-jobs', 'receiptJobs'],
    ]) {
      put(
        `src/adapters/${path}.ts`,
        `import { sendReceipt } from '../notifications/receipt.js';\nexport const ${name} = { receipt: sendReceipt };`,
      );
    }
    rmSync(join(root, 'src/notifications/legacy-receipt.ts'), { force: true });
    put('src/adapters/settings.ts', 'export const settings = { receiptRetryLimit: 3 };');
    if (phase === 'follow-up')
      put(
        'src/notifications/receipt.ts',
        `import type { Order, ReceiptStore } from '../domain/types.js';
export function sendReceipt(order: Order, store: ReceiptStore): void {
  if (store.events.some((event) => event.orderId === order.id)) return;
  store.events.push({ kind: 'receipt.sent', orderId: order.id, to: order.email, transport: 'v2' });
}`,
      );
  }
  if (task === 'dependency-direction') {
    put(
      'src/domain/shipping.ts',
      'export function shippingCost(weight: number, rate: number): number { return weight * rate; }',
    );
    put(
      'src/adapters/shipping.ts',
      `import { shippingCost } from '../domain/shipping.js';
import { webShippingRate } from './web-config.js';
export function webShippingQuote(weight: number): number { return shippingCost(weight, webShippingRate); }
${phase === 'follow-up' ? 'export function batchShippingQuote(weight: number, rate: number): number { return shippingCost(weight, rate); }' : ''}`,
    );
    if (phase === 'follow-up') {
      const path = join(root, 'src/index.ts');
      writeFileSync(
        path,
        readFileSync(path, 'utf8').replace(
          'export { webShippingQuote }',
          'export { webShippingQuote, batchShippingQuote }',
        ),
      );
    }
  }
}

export function applyFlawedPatch(root, task, phase = 'initial') {
  applyReferencePatch(root, task, phase);
  const put = (path, source) => writeFileSync(join(root, path), `${source}\n`);
  if (task === 'shared-rule') {
    put(
      'src/adapters/cancellation-job.ts',
      `import type { CancellationStore, Reservation } from '../domain/types.js';
export function cancelFromJob(reservation: Reservation, now: number, store: CancellationStore): boolean {
  if (reservation.status === 'cancelled' || reservation.startsAt <= now) return false;
  store.cancelled.push(reservation.id);
  store.audit.push({ kind: 'reservation.cancelled', reservationId: reservation.id });
  return true;
}`,
    );
  }
  if (task === 'separate-responsibilities') {
    if (phase === 'initial')
      put(
        'src/adapters/support-quote.ts',
        'export function supportQuote(unitPrice: number, quantity: number): number { return Math.round(unitPrice * quantity * 100) / 100; }',
      );
    else put('src/pricing/refund-fee.ts', "export { chargeFee as refundFee } from './charge-fee.js';");
  }
  if (task === 'retire-implementation') {
    if (phase === 'initial')
      put('src/adapters/settings.ts', 'export const settings = { receiptRetryLimit: 3, legacyReceiptEnabled: false };');
    else
      put(
        'src/notifications/receipt.ts',
        `import type { Order, ReceiptStore } from '../domain/types.js';
const sent = new Set<string>();
export function sendReceipt(order: Order, store: ReceiptStore): void {
  if (sent.has(order.id)) return;
  sent.add(order.id);
  store.events.push({ kind: 'receipt.sent', orderId: order.id, to: order.email, transport: 'v2' });
}`,
      );
  }
  if (task === 'dependency-direction') {
    const path = join(root, '.scipquery.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    config.architecture.allowedDependencies.domain.push('adapters');
    writeFileSync(path, JSON.stringify(config));
  }
}
