export function refundFee(amount: number): number {
  return Math.max(1, Math.round(amount * 0.02));
}
