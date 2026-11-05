import { describe, it, expect } from 'vitest';
import { changePercent, rankDepositChanges } from '../service/deposit-compare.service.js';

const DROPPED_MOST = '00000000-0000-4000-8000-000000000001';
const DROPPED_LESS = '00000000-0000-4000-8000-000000000002';
const DROPPED_TIED = '00000000-0000-4000-8000-000000000003';
const ROSE = '00000000-0000-4000-8000-000000000004';
const ROSE_MOST = '00000000-0000-4000-8000-000000000005';
const UNCHANGED = '00000000-0000-4000-8000-000000000006';
const NEW_DEPOSITOR = '00000000-0000-4000-8000-000000000007';

const players = [
  { playerId: ROSE, depositsA: '100', depositsB: '150', change: '50' },
  { playerId: DROPPED_LESS, depositsA: '100', depositsB: '90', change: '-10' },
  { playerId: UNCHANGED, depositsA: '40', depositsB: '40', change: '0' },
  { playerId: DROPPED_TIED, depositsA: '300', depositsB: '290', change: '-10' },
  { playerId: DROPPED_MOST, depositsA: '800', depositsB: '200', change: '-600' },
  { playerId: NEW_DEPOSITOR, depositsA: '0', depositsB: '75', change: '75' },
  { playerId: ROSE_MOST, depositsA: '1', depositsB: '1000.5', change: '999.5' },
];

describe('rankDepositChanges', () => {
  it('lists only the players whose deposits fell, largest drop first and ties by player id', () => {
    expect(rankDepositChanges(players, 'largest_drop', 10)).toEqual({
      players: [
        {
          playerId: DROPPED_MOST,
          depositsA: '800',
          depositsB: '200',
          change: '-600',
          changePct: -75,
        },
        {
          playerId: DROPPED_LESS,
          depositsA: '100',
          depositsB: '90',
          change: '-10',
          changePct: -10,
        },
        {
          playerId: DROPPED_TIED,
          depositsA: '300',
          depositsB: '290',
          change: '-10',
          changePct: -3.3,
        },
      ],
      truncated: false,
    });
  });

  it('lists only the players whose deposits rose, largest rise first', () => {
    const ranked = rankDepositChanges(players, 'largest_rise', 10);

    expect(ranked.players.map((player) => [player.playerId, player.changePct])).toEqual([
      [ROSE_MOST, 99950],
      [NEW_DEPOSITOR, null],
      [ROSE, 50],
    ]);
  });

  it('keeps the first limit players and says more qualified', () => {
    const ranked = rankDepositChanges(players, 'largest_drop', 2);

    expect(ranked.players.map((player) => player.playerId)).toEqual([DROPPED_MOST, DROPPED_LESS]);
    expect(ranked.truncated).toBe(true);
  });
});

describe('changePercent', () => {
  it('rounds the change relative to the first window to one decimal', () => {
    expect(changePercent({ playerId: ROSE, depositsA: '3', depositsB: '4', change: '1' })).toBe(
      33.3,
    );
    expect(changePercent({ playerId: ROSE, depositsA: '3', depositsB: '1', change: '-2' })).toBe(
      -66.7,
    );
  });

  it('has no percentage when the first window holds nothing', () => {
    expect(
      changePercent({ playerId: ROSE, depositsA: '0', depositsB: '5', change: '5' }),
    ).toBeNull();
  });
});
