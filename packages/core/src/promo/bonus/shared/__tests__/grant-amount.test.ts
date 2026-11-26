import { describe, expect, it } from 'vitest';
import { grantAmountFor } from '../grant-amount.js';

describe('grantAmountFor', () => {
  it('returns the match percent of the deposit when below the cap', () => {
    expect(grantAmountFor('100', '50', '1000')).toBe('50.000000000000000000');
    expect(grantAmountFor('250.5', '100', '1000')).toBe('250.500000000000000000');
  });

  it('returns the cap when the match exceeds it', () => {
    expect(grantAmountFor('5000', '100', '1000')).toBe('1000');
    expect(grantAmountFor('1000.01', '100', '1000')).toBe('1000');
  });

  it('returns the cap exactly when the match equals it', () => {
    expect(grantAmountFor('1000', '100', '1000')).toBe('1000.000000000000000000');
    expect(grantAmountFor('500', '200', '1000')).toBe('1000.000000000000000000');
  });

  it('truncates a sub-unit remainder instead of rounding up', () => {
    expect(grantAmountFor('0.000000000000000001', '50', '1000')).toBe('0.000000000000000000');
    expect(grantAmountFor('0.000000000000000003', '50', '1000')).toBe('0.000000000000000001');
    expect(grantAmountFor('1000.000000000000000001', '100', '1000.000000000000000000')).toBe(
      '1000.000000000000000000',
    );
  });
});
