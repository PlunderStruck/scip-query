export interface Reservation {
  id: string;
  status: 'pending' | 'confirmed' | 'cancelled';
  startsAt: number;
  locked: boolean;
}
export interface CancellationStore {
  cancelled: string[];
  audit: Array<{ kind: 'reservation.cancelled'; reservationId: string }>;
}
export interface Order {
  id: string;
  email: string;
}
export interface ReceiptStore {
  events: Array<{ kind: 'receipt.sent'; orderId: string; to: string; transport: 'v1' | 'v2' }>;
}
