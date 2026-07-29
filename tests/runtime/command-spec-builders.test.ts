import { describe, expect, it } from 'vitest';
import {
  parseInteger,
  parseIntegerLoose,
  parseNonNegativeInteger,
  parseNumber,
  parsePositiveInteger,
} from '../../src/runtime/command-kit/command-spec-builders.js';

describe('command option parsers', () => {
  it('accepts only complete safe integer tokens', () => {
    expect(parseInteger('-12', undefined)).toBe(-12);
    expect(parseIntegerLoose('+12', undefined)).toBe(12);

    for (const value of ['12junk', '1.5', '', '9007199254740992']) {
      expect(() => parseInteger(value, undefined), value).toThrow(/Expected an integer/u);
    }
  });

  it('distinguishes non-negative and positive integer domains', () => {
    expect(parseNonNegativeInteger('0', undefined)).toBe(0);
    expect(parsePositiveInteger('1', undefined)).toBe(1);
    expect(() => parseNonNegativeInteger('-1', undefined)).toThrow(/non-negative/u);
    expect(() => parsePositiveInteger('0', undefined)).toThrow(/positive/u);
  });

  it('accepts complete finite numeric tokens and rejects suffixes', () => {
    expect(parseNumber('.5', undefined)).toBe(0.5);
    expect(parseNumber('2e3', undefined)).toBe(2_000);

    for (const value of ['0.5junk', 'Infinity', 'NaN', '']) {
      expect(() => parseNumber(value, undefined), value).toThrow(/number/u);
    }
  });
});
