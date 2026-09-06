import type { CancellationStore, Reservation } from '../domain/types.js';
import { cancelReservation } from '../reservations/cancel.js';

export function cancelFromWeb(reservation: Reservation, now: number, store: CancellationStore): { ok: boolean } {
  return { ok: cancelReservation(reservation, now, store) };
}
