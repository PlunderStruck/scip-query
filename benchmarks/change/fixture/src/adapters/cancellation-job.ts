import type { CancellationStore, Reservation } from '../domain/types.js';

export function cancelFromJob(reservation: Reservation, now: number, store: CancellationStore): boolean {
  if (reservation.status === 'cancelled' || reservation.startsAt <= now) return false;
  store.cancelled.push(reservation.id);
  store.audit.push({ kind: 'reservation.cancelled', reservationId: reservation.id });
  return true;
}
