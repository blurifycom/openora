import { describe, expect, it } from 'vitest';
import { moneyEquals } from '@openora/core/server';
import { maxBetTermsIssues, resolveMaxBet } from '../max-bet.js';

describe('resolveMaxBet', () => {
  it.each([
    ['no terms', {}, null],
    ['null maxBet', { maxBet: null }, null],
    ['flat maxBet', { maxBet: '5' }, '5'],
    ['rate scales the grant', { maxBetRate: '0.1' }, '10'],
    ['floor lifts a low rate result', { maxBetRate: '0.01', maxBetFloor: '5' }, '5'],
    ['ceiling caps a high rate result', { maxBetRate: '0.5', maxBetCeiling: '20' }, '20'],
    ['floor ignored when already above', { maxBetRate: '0.1', maxBetFloor: '5' }, '10'],
    ['ceiling ignored when already below', { maxBetRate: '0.1', maxBetCeiling: '50' }, '10'],
    ['floor and ceiling ignored without a rate', { maxBet: '3', maxBetFloor: '5' }, '3'],
    ['floor equal to result', { maxBetRate: '0.1', maxBetFloor: '10' }, '10'],
    ['null floor and ceiling', { maxBetRate: '0.1', maxBetFloor: null, maxBetCeiling: null }, '10'],
    ['rate wins over maxBet', { maxBet: '3', maxBetRate: '0.1' }, '10'],
  ])('%s', (_name, terms, expected) => {
    const resolved = resolveMaxBet('100', terms);
    if (expected === null) {
      expect(resolved).toBeNull();
    } else {
      expect(resolved !== null && moneyEquals(resolved, expected)).toBe(true);
    }
  });
});

describe('maxBetTermsIssues', () => {
  it.each([
    ['empty terms', {}, 0],
    ['maxBet only', { maxBet: '5' }, 0],
    ['rate with bounds in order', { maxBetRate: '0.1', maxBetFloor: '1', maxBetCeiling: '5' }, 0],
    ['equal bounds', { maxBetFloor: '5', maxBetCeiling: '5' }, 0],
    ['maxBetRate only', { maxBetRate: '0.1' }, 0],
    ['maxBet with null rate', { maxBet: '5', maxBetRate: null }, 0],
    ['rate with null maxBet', { maxBet: null, maxBetRate: '0.1' }, 0],
    ['maxBet and rate together', { maxBet: '5', maxBetRate: '0.1' }, 1],
    ['floor above ceiling', { maxBetFloor: '6', maxBetCeiling: '5' }, 1],
    ['both problems', { maxBet: '5', maxBetRate: '0.1', maxBetFloor: '6', maxBetCeiling: '5' }, 2],
  ])('%s yields %i issues', (_name, terms, count) => {
    expect(maxBetTermsIssues(terms)).toHaveLength(count);
  });

  it('names each contradiction', () => {
    expect(
      maxBetTermsIssues({ maxBet: '5', maxBetRate: '0.1', maxBetFloor: '6', maxBetCeiling: '5' }),
    ).toEqual([
      'maxBet and maxBetRate are two ways to set the same limit; give one',
      'maxBetFloor must not exceed maxBetCeiling',
    ]);
  });
});
