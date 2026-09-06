import { shippingCost } from '../domain/shipping.js';
import { webShippingRate } from './web-config.js';

export function webShippingQuote(weight: number): number {
  return shippingCost(weight, webShippingRate);
}
