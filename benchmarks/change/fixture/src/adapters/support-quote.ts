export function supportQuote(unitPrice: number, quantity: number): number {
  return Math.round(unitPrice * quantity * 100) / 100;
}
