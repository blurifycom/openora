import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { moneyAdd, moneyCompare, moneyEquals, moneyScaleBy } from '@openora/core/server';
import { capConversion } from '../../shared/complete-grant.js';
import { splitAcrossGrants, strictestMaxBet } from '../wagering.service.js';

type Grant = Parameters<typeof strictestMaxBet>[0][number];

const grant = (over: { terms?: Partial<Grant['terms']> }): Grant => ({
  id: '00000000-0000-4000-8000-000000000001',
  grantedAmount: '100',
  bonusBalance: '100',
  unlinkedCash: '0',
  linkedCash: '0',
  wageringRequired: '1000',
  wageringProgress: '0',
  expiresAt: new Date('2026-12-01T00:00:00.000Z'),
  createdAt: new Date('2026-11-01T00:00:00.000Z'),
  terms: { wageringMultiplier: '10', expiryDays: 7, weights: [], ...over.terms },
});

const same = (a: string | null, b: string | null) =>
  a === null || b === null ? a === b : moneyEquals(a, b);

describe('capConversion', () => {
  it.each([
    ['no multiplier', '500', '100', undefined, '500'],
    ['null multiplier', '500', '100', null, '500'],
    ['balance above the ceiling', '500', '100', '3', '300'],
    ['balance below the ceiling', '200', '100', '3', '200'],
    ['balance at the ceiling', '300', '100', '3', '300'],
    ['zero multiplier pays nothing', '500', '100', '0', '0'],
    ['fractional multiplier', '500', '100', '1.5', '150'],
    ['ceiling truncates', '500', '0.000000000000000003', '0.5', '0.000000000000000001'],
  ])('%s', (_name, balance, granted, multiplier, expected) => {
    expect(moneyEquals(capConversion(balance, granted, multiplier), expected)).toBe(true);
  });

  const money = fc
    .bigInt({ min: 0n, max: 10n ** 27n })
    .map((u) => `${u / 10n ** 18n}.${(u % 10n ** 18n).toString().padStart(18, '0')}`);

  it('never converts more than the balance or the ceiling', () => {
    fc.assert(
      fc.property(money, money, fc.integer({ min: 0, max: 50 }), (balance, granted, mult) => {
        const out = capConversion(balance, granted, String(mult));
        expect(moneyCompare(out, balance)).toBeLessThanOrEqual(0);
        expect(moneyCompare(out, moneyScaleBy(granted, String(mult)))).toBeLessThanOrEqual(0);
        expect(
          moneyEquals(
            out,
            moneyCompare(balance, moneyScaleBy(granted, String(mult))) < 0
              ? balance
              : moneyScaleBy(granted, String(mult)),
          ),
        ).toBe(true);
      }),
    );
  });
});

describe('strictestMaxBet', () => {
  it('is null with no grants', () => {
    expect(strictestMaxBet([], 'casino')).toBeNull();
  });

  it('is null when no grant sets a max bet', () => {
    expect(strictestMaxBet([grant({}), grant({ terms: { maxBet: null } })], 'casino')).toBeNull();
  });

  it('takes the lowest max bet', () => {
    const grants = [
      grant({ terms: { maxBet: '10' } }),
      grant({ terms: { maxBet: '2.5' } }),
      grant({ terms: { maxBet: '5' } }),
    ];
    expect(same(strictestMaxBet(grants, 'casino'), '2.5')).toBe(true);
  });

  it('ignores a grant that exempts the product', () => {
    const grants = [
      grant({ terms: { maxBet: '1', maxBetExemptProducts: ['live-casino'] } }),
      grant({ terms: { maxBet: '5' } }),
    ];
    expect(same(strictestMaxBet(grants, 'live-casino'), '5')).toBe(true);
    expect(same(strictestMaxBet(grants, 'casino'), '1')).toBe(true);
  });

  it('is null when every limiting grant exempts the product', () => {
    const grants = [grant({ terms: { maxBet: '1', maxBetExemptProducts: ['pvp'] } })];
    expect(strictestMaxBet(grants, 'pvp')).toBeNull();
  });

  it('treats a zero max bet as the strictest limit', () => {
    const grants = [grant({ terms: { maxBet: '5' } }), grant({ terms: { maxBet: '0' } })];
    expect(same(strictestMaxBet(grants, 'casino'), '0')).toBe(true);
  });
});

describe('splitAcrossGrants', () => {
  type Split = Parameters<typeof splitAcrossGrants>[0];
  type Bucket = 'unlinked' | 'linked' | 'bonus';
  const ALL = new Set<Bucket>(['unlinked', 'linked', 'bonus']);
  const held = (unlinked: string, linked: string, bonus: string, allowed: Set<Bucket> = ALL) => ({
    available: { unlinked, linked, bonus },
    allowed,
  });
  const flat = (out: ReturnType<typeof splitAcrossGrants>) =>
    out && [out.free, ...out.grants.flatMap((g) => [g.unlinked, g.linked, g.bonus])];
  const same18 = (actual: (string | undefined)[] | null, expected: string[]) =>
    actual !== null && actual.every((v, i) => moneyEquals(v ?? '', expected[i] ?? ''));

  const twoGrants: Split['grants'] = [held('10', '20', '30'), held('5', '0', '40')];

  it.each<[string, string, Split['order'], string[]]>([
    ['zero takes nothing', '0', 'first', ['0', '0', '0', '0', '0', '0', '0']],
    ['free money first', '50', 'first', ['50', '0', '0', '0', '0', '0', '0']],
    [
      'free money first spills into the first grant',
      '115',
      'first',
      ['100', '10', '5', '0', '0', '0', '0'],
    ],
    [
      'free money last starts on the first grant',
      '15',
      'last',
      ['0', '10', '5', '0', '0', '0', '0'],
    ],
    [
      'inside one grant cash goes before bonus',
      '35',
      'last',
      ['0', '10', '20', '5', '0', '0', '0'],
    ],
    [
      'free money last is reached after every grant',
      '120',
      'last',
      ['15', '10', '20', '30', '5', '0', '40'],
    ],
    ['exactly everything', '205', 'first', ['100', '10', '20', '30', '5', '0', '40']],
  ])('%s', (_name, stake, order, expected) => {
    expect(
      same18(flat(splitAcrossGrants({ stake, free: '100', grants: twoGrants, order })), expected),
    ).toBe(true);
  });

  it('is null when everything the bet may use falls short', () => {
    expect(
      splitAcrossGrants({
        stake: '205.000000000000000001',
        free: '100',
        grants: twoGrants,
        order: 'first',
      }),
    ).toBeNull();
  });

  it('never takes from a bucket the bet may not use', () => {
    const grants = [held('10', '20', '30', new Set<Bucket>(['bonus']))];
    expect(
      same18(flat(splitAcrossGrants({ stake: '25', free: '0', grants, order: 'first' })), [
        '0',
        '0',
        '0',
        '25',
      ]),
    ).toBe(true);
    expect(splitAcrossGrants({ stake: '31', free: '0', grants, order: 'first' })).toBeNull();
  });

  it('is null for a positive stake with nothing to draw on', () => {
    expect(splitAcrossGrants({ stake: '1', free: '0', grants: [], order: 'last' })).toBeNull();
  });

  const money = (max: bigint) =>
    fc
      .bigInt({ min: 0n, max })
      .map((u) => `${u / 10n ** 18n}.${(u % 10n ** 18n).toString().padStart(18, '0')}`);
  const bucket = fc.constantFrom<Bucket>('unlinked', 'linked', 'bonus');

  it('takes exactly the stake and never more than a bucket holds', () => {
    fc.assert(
      fc.property(
        money(10n ** 21n),
        fc.array(
          fc.record({
            unlinked: money(10n ** 21n),
            linked: money(10n ** 21n),
            bonus: money(10n ** 21n),
            allowed: fc.uniqueArray(bucket, { maxLength: 3 }),
          }),
          { maxLength: 4 },
        ),
        money(10n ** 22n),
        fc.constantFrom<Split['order']>('first', 'last'),
        (free, raw, stake, order) => {
          const grants = raw.map((g) => held(g.unlinked, g.linked, g.bonus, new Set(g.allowed)));
          const out = splitAcrossGrants({ stake, free, grants, order });
          const usable = raw.reduce(
            (sum, g) => g.allowed.reduce((s, b) => moneyAdd(s, g[b]), sum),
            free,
          );
          if (out === null) {
            expect(moneyCompare(stake, usable)).toBeGreaterThan(0);
            return;
          }
          const taken = out.grants.reduce(
            (sum, g) => moneyAdd(moneyAdd(moneyAdd(sum, g.unlinked), g.linked), g.bonus),
            out.free,
          );
          expect(moneyEquals(taken, stake)).toBe(true);
          expect(moneyCompare(out.free, free)).toBeLessThanOrEqual(0);
          out.grants.forEach((g, i) => {
            for (const b of ['unlinked', 'linked', 'bonus'] as const) {
              const limit = raw[i]?.allowed.includes(b) ? (raw[i]?.[b] ?? '0') : '0';
              expect(moneyCompare(g[b], limit)).toBeLessThanOrEqual(0);
            }
          });
        },
      ),
    );
  });
});
