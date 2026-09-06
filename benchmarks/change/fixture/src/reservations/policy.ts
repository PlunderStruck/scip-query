import type { Reservation } from '../domain/types.js';

export function canCancel(reservation: Reservation, now: number): boolean {
  return reservation.status !== 'cancelled' && reservation.startsAt > now;
}
