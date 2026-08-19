import { describe, expect, it } from 'vitest';

import {
  isBoundedRecordString,
  isNonNegativeFiniteNumber,
  isNonNegativeInteger,
  isPositiveInteger,
  isRecordObject,
  isSha256Hex,
  isStringOrNullRecord,
  isValidRecordTimestamp,
} from '../../src/domain/record-validation.js';

describe('decoded-record validation primitives', () => {
  it('distinguishes named-field records from arrays and null', () => {
    expect(isRecordObject({ key: 'value' })).toBe(true);
    expect(isRecordObject([])).toBe(false);
    expect(isRecordObject(null)).toBe(false);
  });

  it('accepts only string-or-null environment-style records', () => {
    expect(isStringOrNullRecord({ PATH: '/bin', OPTIONAL: null })).toBe(true);
    expect(isStringOrNullRecord({ PATH: 42 })).toBe(false);
    expect(isStringOrNullRecord(['PATH'])).toBe(false);
  });

  it('keeps integer and finite-number boundaries distinct', () => {
    expect(isNonNegativeInteger(0)).toBe(true);
    expect(isNonNegativeInteger(1.5)).toBe(false);
    expect(isNonNegativeInteger(-1)).toBe(false);
    expect(isNonNegativeInteger(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(isPositiveInteger(1)).toBe(true);
    expect(isPositiveInteger(0)).toBe(false);
    expect(isNonNegativeFiniteNumber(1.5)).toBe(true);
    expect(isNonNegativeFiniteNumber(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isNonNegativeFiniteNumber(-0.5)).toBe(false);
  });

  it('accepts only finite parseable timestamp strings', () => {
    expect(isValidRecordTimestamp('2026-07-25T20:00:00.000Z')).toBe(true);
    expect(isValidRecordTimestamp('not-a-time')).toBe(false);
    expect(isValidRecordTimestamp(0)).toBe(false);
  });

  it('accepts only lowercase 64-character hex SHA-256 digests', () => {
    expect(isSha256Hex('a'.repeat(64))).toBe(true);
    expect(isSha256Hex('A'.repeat(64))).toBe(false);
    expect(isSha256Hex('a'.repeat(63))).toBe(false);
    expect(isSha256Hex(42)).toBe(false);
  });

  it('bounds one-line identity and name fields', () => {
    expect(isBoundedRecordString('identity')).toBe(true);
    expect(isBoundedRecordString('')).toBe(false);
    expect(isBoundedRecordString('x'.repeat(257))).toBe(false);
    expect(isBoundedRecordString('two\nlines')).toBe(false);
    expect(isBoundedRecordString(42)).toBe(false);
  });
});
