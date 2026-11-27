import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  assertKnownTiers,
  assertLadderHolds,
  RankLadderInvalidError,
  RankLadderMismatchError,
} from '../rank-admin.service.js';
import { ladderVersion } from '../rank-challenge-admin.service.js';

type Tier = Parameters<typeof assertKnownTiers>[1][number];

const TIER_A = 'abcdef77-7777-4777-8777-777777777777';
const TIER_B = '88888888-8888-4888-8888-888888888888';

const tier = (over: Partial<Tier>): Tier => ({
  key: 'bronze',
  name: 'Bronze',
  wagerThreshold: '0',
  rakebackPercent: '1',
  dailyBonus: null,
  weeklyBonus: null,
  monthlyBonus: null,
  levelUpBonus: null,
  ...over,
});

const thresholds = (...values: string[]) => values.map((wagerThreshold) => ({ wagerThreshold }));

describe('assertLadderHolds', () => {
  it.each([
    ['one tier at zero', thresholds('0')],
    ['zero written with decimals', thresholds('0.00', '1')],
    ['strictly rising thresholds', thresholds('0', '100', '1000')],
    ['a rise of one smallest unit', thresholds('0', '0.000000000000000001')],
    ['numerically rising but not as strings', thresholds('0', '9', '10')],
  ])('accepts %s', (_name, ladder) => {
    expect(() => assertLadderHolds(ladder)).not.toThrow();
  });

  it.each([
    ['an empty ladder', thresholds(), /at least one tier/],
    ['a lowest tier above zero', thresholds('1'), /start at zero/],
    ['a lowest tier of one smallest unit', thresholds('0.000000000000000001'), /start at zero/],
    ['a repeated threshold', thresholds('0', '100', '100'), /more than the one below/],
    [
      'a threshold equal after trailing zeros',
      thresholds('0', '100', '100.00'),
      /more than the one below/,
    ],
    ['a falling threshold', thresholds('0', '100', '50'), /more than the one below/],
    ['a second tier at zero', thresholds('0', '0'), /more than the one below/],
    [
      'as strings rising but numerically falling',
      thresholds('0', '10', '9'),
      /more than the one below/,
    ],
  ])('refuses %s', (_name, ladder, reason) => {
    expect(() => assertLadderHolds(ladder)).toThrow(RankLadderInvalidError);
    expect(() => assertLadderHolds(ladder)).toThrow(reason);
  });

  it('accepts a ladder exactly when every threshold rises from zero', () => {
    fc.assert(
      fc.property(fc.array(fc.nat(50), { minLength: 1, maxLength: 8 }), (values) => {
        const ladder = thresholds(...values.map(String));
        const holds =
          values[0] === 0 &&
          values.every((value, index) => index === 0 || value > (values[index - 1] ?? 0));
        if (holds) {
          expect(() => assertLadderHolds(ladder)).not.toThrow();
        } else {
          expect(() => assertLadderHolds(ladder)).toThrow(RankLadderInvalidError);
        }
      }),
    );
  });
});

describe('assertKnownTiers', () => {
  it.each([
    ['only new tiers', new Set<string>(), [tier({}), tier({ key: 'silver' })]],
    ['known ids', new Set([TIER_A, TIER_B]), [tier({ id: TIER_A }), tier({ id: TIER_B })]],
    ['a mix of known and new', new Set([TIER_A]), [tier({ id: TIER_A }), tier({ key: 'silver' })]],
    ['no tiers', new Set([TIER_A]), []],
  ])('accepts %s', (_name, known, tiers) => {
    expect(() => assertKnownTiers(known, tiers)).not.toThrow();
  });

  it('refuses an id the ladder does not hold and names it', () => {
    expect(() => assertKnownTiers(new Set([TIER_A]), [tier({ id: TIER_B })])).toThrow(
      RankLadderMismatchError,
    );
    expect(() => assertKnownTiers(new Set([TIER_A]), [tier({ id: TIER_B })])).toThrow(TIER_B);
  });

  it('refuses a known id written in another case', () => {
    expect(() => assertKnownTiers(new Set([TIER_A]), [tier({ id: TIER_A.toUpperCase() })])).toThrow(
      RankLadderMismatchError,
    );
  });

  it('names every unknown id', () => {
    expect(() =>
      assertKnownTiers(new Set<string>(), [tier({ id: TIER_A }), tier({ id: TIER_B })]),
    ).toThrow(`${TIER_A}, ${TIER_B}`);
  });
});

describe('ladderVersion', () => {
  const row = { id: TIER_A, position: 0, wagerThreshold: '100', reward: '5' };

  it('is a sha256 hex digest', () => {
    expect(ladderVersion([row])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable for the same rows', () => {
    expect(ladderVersion([{ ...row }])).toBe(ladderVersion([row]));
  });

  it('changes when a tier is added or removed', () => {
    const second = { ...row, id: TIER_B, position: 1 };
    expect(ladderVersion([row, second])).not.toBe(ladderVersion([row]));
    expect(ladderVersion([])).not.toBe(ladderVersion([row]));
  });

  it('changes when two tiers swap places', () => {
    const second = { ...row, id: TIER_B, position: 1 };
    expect(ladderVersion([second, row])).not.toBe(ladderVersion([row, second]));
  });

  it('changes when a value moves to a trailing-zero spelling', () => {
    expect(ladderVersion([{ ...row, reward: '5.0' }])).not.toBe(ladderVersion([row]));
  });

  it('changes when a field turns from null to the string null', () => {
    expect(ladderVersion([{ ...row, reward: null }])).not.toBe(
      ladderVersion([{ ...row, reward: 'null' }]),
    );
  });

  it('changes on any edit to any field of any tier', () => {
    const tierRow = fc.record({
      id: fc.uuid(),
      position: fc.nat(20),
      wagerThreshold: fc.string(),
      reward: fc.option(fc.string(), { nil: null }),
    });
    fc.assert(
      fc.property(
        fc.array(tierRow, { minLength: 1, maxLength: 5 }),
        fc.nat(),
        fc.constantFrom('id', 'position', 'wagerThreshold', 'reward'),
        fc.string({ minLength: 1 }),
        (rows, pick, field, suffix) => {
          const index = pick % rows.length;
          const edited = rows.map((entry, at) => {
            if (at !== index) {
              return entry;
            }
            return field === 'position'
              ? { ...entry, position: entry.position + 1 }
              : { ...entry, [field]: `${entry[field] ?? ''}${suffix}` };
          });
          expect(ladderVersion(edited)).not.toBe(ladderVersion(rows));
        },
      ),
    );
  });
});
