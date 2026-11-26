import { describe, expect, it } from 'vitest';
import { PLAYER_STATUSES } from '@openora/core/contracts';
import { accountStatusOf } from '../support-chat.service.js';

type Reading = Parameters<typeof accountStatusOf>[0];

const reading = (over: Partial<Reading>): Reading => ({
  playerId: 'a1b2c3d4-0000-4000-8000-000000000001',
  userId: 'a1b2c3d4-0000-4000-8000-000000000002',
  username: 'someone',
  email: 'someone@example.test',
  isSelfExcluded: false,
  isCoolingOff: false,
  kycStatus: 'approved',
  rankName: null,
  accountManagerName: null,
  activeCurrency: 'USD',
  playerStatus: 'active',
  ...over,
});

describe('accountStatusOf', () => {
  it.each(PLAYER_STATUSES)('keeps %s when the player is not self-excluded', (playerStatus) => {
    expect(accountStatusOf(reading({ playerStatus, isSelfExcluded: false }))).toBe(playerStatus);
  });

  it.each([
    ['suspended', 'suspended'],
    ['closed', 'closed'],
    ['active', 'self_excluded'],
    ['dormant', 'self_excluded'],
    ['self_excluded', 'self_excluded'],
  ] as const)('with a self-exclusion, %s becomes %s', (playerStatus, expected) => {
    expect(accountStatusOf(reading({ playerStatus, isSelfExcluded: true }))).toBe(expected);
  });

  it('never reports a closed or suspended account as active or self-excluded', () => {
    for (const playerStatus of ['closed', 'suspended'] as const) {
      for (const isSelfExcluded of [true, false]) {
        expect(accountStatusOf(reading({ playerStatus, isSelfExcluded }))).toBe(playerStatus);
      }
    }
  });
});
