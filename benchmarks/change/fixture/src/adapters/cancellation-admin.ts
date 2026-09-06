import type { CancellationStore, Reservation } from '../domain/types.js';
import { cancelReservation } from '../reservations/cancel.js';

export function cancelFromAdmin(reservation: Reservation, now: number, store: CancellationStore): boolean {
  return cancelReservation(reservation, now, store);
}
