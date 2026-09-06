import type { CancellationStore, Reservation } from '../domain/types.js';
import { canCancel } from './policy.js';

export function cancelReservation(reservation: Reservation, now: number, store: CancellationStore): boolean {
  if (!canCancel(reservation, now)) return false;
  store.cancelled.push(reservation.id);
  store.audit.push({ kind: 'reservation.cancelled', reservationId: reservation.id });
  return true;
}
