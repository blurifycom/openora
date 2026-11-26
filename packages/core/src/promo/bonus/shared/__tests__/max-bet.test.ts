import { describe, expect, it } from 'vitest';
import { maxBetTermsIssues, resolveMaxBet } from '../max-bet.js';

describe('resolveMaxBet', () => {
  it('returns the fixed max bet when no rate is set', () => {
    expect(resolveMaxBet('100', { maxBet: '5' })).toBe('5');
    expect(resolveMaxBet('100', { maxBet: '5', maxBetRate: null })).toBe('5');
  });

  it('returns null when neither a rate nor a fixed max bet is set', () => {
    expect(resolveMaxBet('100', {})).toBeNull();
    expect(resolveMaxBet('100', { maxBet: null, maxBetRate: null })).toBeNull();
  });

  it('scales the granted amount by the rate', () => {
    expect(resolveMaxBet('100', { maxBetRate: '0.1' })).toBe('10.000000000000000000');
    expect(resolveMaxBet('250', { maxBetRate: '0.05' })).toBe('12.500000000000000000');
  });

  it('raises the result to the floor when below it', () => {
    expect(resolveMaxBet('100', { maxBetRate: '0.01', maxBetFloor: '5' })).toBe('5');
  });

  it('lowers the result to the ceiling when above it', () => {
    expect(resolveMaxBet('100', { maxBetRate: '0.5', maxBetCeiling: '20' })).toBe('20');
  });

  it('keeps the result when between floor and ceiling', () => {
    expect(resolveMaxBet('100', { maxBetRate: '0.1', maxBetFloor: '5', maxBetCeiling: '20' })).toBe(
      '10.000000000000000000',
    );
    expect(
      resolveMaxBet('100', { maxBetRate: '0.05', maxBetFloor: '5', maxBetCeiling: '20' }),
    ).toBe('5.000000000000000000');
    expect(resolveMaxBet('100', { maxBetRate: '0.2', maxBetFloor: '5', maxBetCeiling: '20' })).toBe(
      '20.000000000000000000',
    );
  });
});

describe('maxBetTermsIssues', () => {
  it('reports no issue for coherent terms', () => {
    expect(maxBetTermsIssues({})).toEqual([]);
    expect(maxBetTermsIssues({ maxBet: '5' })).toEqual([]);
    expect(maxBetTermsIssues({ maxBetRate: '0.1', maxBetFloor: '5', maxBetCeiling: '5' })).toEqual(
      [],
    );
  });

  it('reports an issue when both a fixed max bet and a rate are given', () => {
    expect(maxBetTermsIssues({ maxBet: '5', maxBetRate: '0.1' })).toEqual([
      expect.stringContaining('maxBet and maxBetRate'),
    ]);
  });

  it('reports an issue when the floor is above the ceiling', () => {
    expect(maxBetTermsIssues({ maxBetRate: '0.1', maxBetFloor: '20', maxBetCeiling: '5' })).toEqual(
      [expect.stringContaining('maxBetFloor must not exceed maxBetCeiling')],
    );
  });

  it.todo('reports an issue when a floor or ceiling is given without a rate');
});
