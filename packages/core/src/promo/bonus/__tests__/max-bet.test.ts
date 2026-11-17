import { describe, it, expect } from 'vitest';
import { maxBetTermsIssues, resolveMaxBet } from '../shared/max-bet.js';

const resolved = (...args: Parameters<typeof resolveMaxBet>) => Number(resolveMaxBet(...args));

describe('resolveMaxBet', () => {
  it('is no limit with no rate, whatever the floor and ceiling say', () => {
    expect(resolveMaxBet('100', { maxBetFloor: '5', maxBetCeiling: '50' })).toBeNull();
    expect(resolveMaxBet('100', { maxBetRate: null, maxBetFloor: '5' })).toBeNull();
  });

  it('keeps an explicit max bet when no rate is given', () => {
    expect(resolveMaxBet('100', { maxBet: '7' })).toBe('7');
  });

  it('is the original amount times the rate', () => {
    expect(resolved('200', { maxBetRate: '0.05' })).toBe(10);
  });

  it('lifts a rate-derived value that falls under the floor', () => {
    expect(resolved('100', { maxBetRate: '0.01', maxBetFloor: '5' })).toBe(5);
  });

  it('caps a rate-derived value that rises over the ceiling', () => {
    expect(resolved('10000', { maxBetRate: '0.1', maxBetCeiling: '250' })).toBe(250);
  });

  it('leaves a value between floor and ceiling alone', () => {
    expect(resolved('100', { maxBetRate: '0.1', maxBetFloor: '5', maxBetCeiling: '50' })).toBe(10);
  });

  it('lets the ceiling win when the floor sits above it', () => {
    expect(resolved('100', { maxBetRate: '0.01', maxBetFloor: '20', maxBetCeiling: '5' })).toBe(5);
  });

  it('truncates the product to money precision rather than rounding up', () => {
    const value = resolveMaxBet('1', { maxBetRate: '0.123456789012345678' });
    expect(value).toBe('0.123456789012345678');
    expect(resolveMaxBet('0.000000000000000003', { maxBetRate: '0.5' })).toBe(
      '0.000000000000000001',
    );
  });
});

describe('maxBetTermsIssues', () => {
  it('accepts coherent terms', () => {
    expect(maxBetTermsIssues({})).toEqual([]);
    expect(maxBetTermsIssues({ maxBetRate: '0.1', maxBetFloor: '5', maxBetCeiling: '5' })).toEqual(
      [],
    );
  });

  it('refuses a rate beside an explicit max bet', () => {
    expect(maxBetTermsIssues({ maxBet: '5', maxBetRate: '0.1' })).toHaveLength(1);
  });

  it('refuses a floor above the ceiling', () => {
    expect(maxBetTermsIssues({ maxBetFloor: '10', maxBetCeiling: '5' })).toHaveLength(1);
  });
});
