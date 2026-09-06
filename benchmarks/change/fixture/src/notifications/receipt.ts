import type { Order, ReceiptStore } from '../domain/types.js';

export function sendReceipt(order: Order, store: ReceiptStore): void {
  store.events.push({ kind: 'receipt.sent', orderId: order.id, to: order.email, transport: 'v2' });
}
