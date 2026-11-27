import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { changePercent, groupByUser, rankDepositChanges } from '../deposit-compare.service.js';

type Priced = Parameters<typeof changePercent>[0];
type Row = Parameters<typeof groupByUser>[0][number];

const priced = (playerId: Priced['playerId'], change: string, depositsA = '100'): Priced => ({
  playerId,
  depositsA,
  depositsB: '0',
  change,
});

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const amount = fc
  .tuple(fc.nat(1_000_000), fc.nat(99_999_999))
  .map(([whole, fraction]) => `${whole}.${String(fraction).padStart(8, '0')}`);

describe('changePercent', () => {
  it.each([
    ['nothing in window A', '0', '50', null],
    ['window A written with decimals', '0.00000000', '50', null],
    ['doubled', '100', '100', 100],
    ['halved', '100', '-50', -50],
    ['wiped out', '100', '-100', -100],
    ['unchanged', '100', '0', 0],
    ['one third rounds to one decimal', '3', '1', 33.3],
    ['two thirds rounds up', '3', '2', 66.7],
    ['a tenth of a percent', '1000', '1', 0.1],
    ['under half a tenth rounds to zero', '10000', '4', 0],
    ['big growth', '0.00000001', '1', 10000000000],
  ] as const)('%s', (_name, depositsA, change, expected) => {
    expect(changePercent(priced(id(1), change, depositsA))).toBe(expected);
  });

  it.each([
    ['a quarter tenth', '400', '49', '-49'],
    ['one eighth', '800', '1', '-1'],
    ['a half tenth', '10000', '5', '-5'],
  ])('rounds a drop to the same size as the matching rise: %s', (_name, depositsA, up, down) => {
    const rise = changePercent(priced(id(1), up, depositsA));
    const drop = changePercent(priced(id(1), down, depositsA));
    expect(drop).toBe(rise === null ? null : -rise);
  });

  it('rounds a drop and a rise of the same size to the same magnitude', () => {
    fc.assert(
      fc.property(
        amount.filter((value) => Number(value) > 0),
        amount,
        (depositsA, change) => {
          const rise = changePercent(priced(id(1), change, depositsA));
          const drop = changePercent(priced(id(1), `-${change}`, depositsA));
          expect(Math.abs(drop ?? 0)).toBe(Math.abs(rise ?? 0));
        },
      ),
    );
  });
});

describe('rankDepositChanges', () => {
  const players = [
    priced(id(1), '10'),
    priced(id(2), '-30'),
    priced(id(3), '0'),
    priced(id(4), '50'),
    priced(id(5), '-5'),
    priced(id(6), '10'),
  ];

  it('lists only rises for largest_rise, largest first', () => {
    expect(rankDepositChanges(players, 'largest_rise', 10).players.map((p) => p.playerId)).toEqual([
      id(4),
      id(1),
      id(6),
    ]);
  });

  it('lists only drops for largest_drop, deepest first', () => {
    expect(rankDepositChanges(players, 'largest_drop', 10).players.map((p) => p.playerId)).toEqual([
      id(2),
      id(5),
    ]);
  });

  it('never lists an unchanged player in either direction', () => {
    for (const order of ['largest_rise', 'largest_drop'] as const) {
      expect(rankDepositChanges(players, order, 10).players.some((p) => p.playerId === id(3))).toBe(
        false,
      );
    }
  });

  it('breaks a tie by player id whatever the input order', () => {
    const reversed = [...players].reverse();
    expect(rankDepositChanges(reversed, 'largest_rise', 10).players.map((p) => p.playerId)).toEqual(
      [id(4), id(1), id(6)],
    );
  });

  it('compares changes as exact decimals, not as strings or floats', () => {
    const ranked = rankDepositChanges(
      [
        priced(id(1), '9'),
        priced(id(2), '10'),
        priced(id(3), '9.00000001'),
        priced(id(4), '9.000000001'),
      ],
      'largest_rise',
      10,
    );
    expect(ranked.players.map((p) => p.playerId)).toEqual([id(2), id(3), id(4), id(1)]);
  });

  it.each([
    ['limit above the movers', 5, 3, false],
    ['limit equal to the movers', 3, 3, false],
    ['limit one below the movers', 2, 2, true],
    ['zero limit', 0, 0, true],
  ])('%s', (_name, limit, shown, truncated) => {
    const ranked = rankDepositChanges(players, 'largest_rise', limit);
    expect(ranked.players).toHaveLength(shown);
    expect(ranked.truncated).toBe(truncated);
  });

  it('does not report truncation when nobody moved', () => {
    expect(rankDepositChanges([priced(id(3), '0')], 'largest_drop', 0)).toEqual({
      players: [],
      truncated: false,
    });
  });

  it('attaches the change percentage to each listed player', () => {
    expect(rankDepositChanges([priced(id(1), '-25')], 'largest_drop', 1).players).toEqual([
      { ...priced(id(1), '-25'), changePct: -25 },
    ]);
  });

  it('gives the same ranking for any input order', () => {
    const entries = fc.uniqueArray(
      fc.record({ n: fc.nat(500), change: fc.integer({ min: -50, max: 50 }) }),
      { selector: (entry) => entry.n, maxLength: 30 },
    );
    fc.assert(
      fc.property(entries, fc.nat(40), fc.boolean(), (list, limit, drop) => {
        const input = list.map((entry) => priced(id(entry.n), String(entry.change)));
        const order = drop ? 'largest_drop' : 'largest_rise';
        expect(rankDepositChanges([...input].reverse(), order, limit)).toEqual(
          rankDepositChanges(input, order, limit),
        );
      }),
    );
  });
});

describe('groupByUser', () => {
  const row = (over: Partial<Row>): Row => ({
    userId: id(1),
    currency: 'BTC',
    depositsA: '1',
    depositsB: '2',
    ...over,
  });

  it('is empty for no rows', () => {
    expect(groupByUser([]).size).toBe(0);
  });

  it('keeps every currency row of a player in input order', () => {
    const rows = [
      row({ currency: 'BTC' }),
      row({ userId: id(2), currency: 'ETH' }),
      row({ currency: 'USDT' }),
    ];
    const grouped = groupByUser(rows);
    expect(grouped.get(id(1))).toEqual([rows[0], rows[2]]);
    expect(grouped.get(id(2))).toEqual([rows[1]]);
  });

  it('keeps a duplicate row instead of collapsing it', () => {
    const rows = [row({}), row({})];
    expect(groupByUser(rows).get(id(1))).toHaveLength(2);
  });

  it('loses and invents no row', () => {
    fc.assert(
      fc.property(fc.array(fc.nat(5), { maxLength: 40 }), (owners) => {
        const rows = owners.map((owner, index) =>
          row({ userId: id(owner), depositsA: String(index) }),
        );
        const grouped = groupByUser(rows);
        expect([...grouped.values()].flat()).toHaveLength(rows.length);
        for (const [userId, list] of grouped) {
          expect(list.every((entry) => entry.userId === userId)).toBe(true);
        }
      }),
    );
  });
});
