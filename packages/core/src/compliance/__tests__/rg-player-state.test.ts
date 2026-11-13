import { describe, it, expect } from 'vitest';
import { toRgPlayerState } from '../service/rg-player-state.service.js';

const PLAYER_ID = '11111111-1111-4111-8111-111111111111';

describe('toRgPlayerState', () => {
  it('serves the standing with ISO times, a money limit with its currency and a session one in minutes', () => {
    const state = toRgPlayerState(PLAYER_ID, {
      restricted: true,
      activeExclusions: [
        {
          kind: 'cooling_off',
          startsAt: new Date('2026-11-01T10:00:00.000Z'),
          expiresAt: new Date('2026-11-08T10:00:00.000Z'),
          isPermanent: false,
        },
      ],
      selfExclusionsOnRecord: 1,
      lastSelfExclusionEndedAt: new Date('2026-06-01T00:00:00.000Z'),
      lastCoolingOffEndedAt: null,
      activeFlags: [
        {
          flagType: 'limit_threshold',
          limitType: 'deposit',
          flaggedAt: new Date('2026-11-02T08:00:00.000Z'),
        },
      ],
      limits: [
        {
          type: 'deposit',
          period: 'weekly',
          amount: '500',
          currency: 'EUR',
          pendingKind: 'increase',
          pendingRequestedAt: new Date('2026-11-03T09:00:00.000Z'),
        },
        {
          type: 'session',
          period: 'session',
          minutes: 90,
          pendingKind: null,
          pendingRequestedAt: null,
        },
      ],
      pivotCurrency: 'USD',
      windows: [{ days: 7, totals: { deposits: '120.5', bets: '300', wins: '210' } }],
    });

    expect(state).toEqual({
      playerId: PLAYER_ID,
      restricted: true,
      activeExclusions: [
        {
          kind: 'cooling_off',
          startsAt: '2026-11-01T10:00:00.000Z',
          expiresAt: '2026-11-08T10:00:00.000Z',
          isPermanent: false,
        },
      ],
      selfExclusionsOnRecord: 1,
      lastSelfExclusionEndedAt: '2026-06-01T00:00:00.000Z',
      lastCoolingOffEndedAt: null,
      activeFlags: [
        {
          flagType: 'limit_threshold',
          limitType: 'deposit',
          flaggedAt: '2026-11-02T08:00:00.000Z',
        },
      ],
      limits: [
        {
          type: 'deposit',
          period: 'weekly',
          amount: '500',
          currency: 'EUR',
          minutes: null,
          pendingKind: 'increase',
          pendingRequestedAt: '2026-11-03T09:00:00.000Z',
        },
        {
          type: 'session',
          period: 'session',
          amount: null,
          currency: null,
          minutes: 90,
          pendingKind: null,
          pendingRequestedAt: null,
        },
      ],
      pivotCurrency: 'USD',
      windows: [{ days: 7, totals: { deposits: '120.5', bets: '300', wins: '210' } }],
    });
  });
});
