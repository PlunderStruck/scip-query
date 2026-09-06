export function checkoutQuote(unitPrice: number, quantity: number): number {
  return Math.round(unitPrice * quantity * 100) / 100;
}
