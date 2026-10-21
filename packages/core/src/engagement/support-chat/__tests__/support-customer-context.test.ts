import { describe, it, expect } from 'vitest';
import { SupportCustomerContextSchema } from '@openora/core/contracts';
import {
  MAX_EXTRA_SYNC_ROUNDS,
  SupportContextNotSettledError,
  syncUntilSettled,
  toSupportCustomerContext,
  type SupportCustomerReading,
} from '../service/support-chat.service.js';

const NOW = new Date('2026-01-02T03:04:05.000Z');

const reading = (overrides: Partial<SupportCustomerReading> = {}): SupportCustomerReading => ({
  playerId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
  username: 'player-one',
  email: 'player-one@example.test',
  playerStatus: 'active',
  kycStatus: 'pending',
  rankName: 'Bronze',
  isSelfExcluded: false,
  isCoolingOff: false,
  activeCurrency: 'USD',
  ...overrides,
});

describe('toSupportCustomerContext', () => {
  it('copies the reading and stamps when it was read', () => {
    expect(toSupportCustomerContext(reading(), NOW)).toEqual({
      playerId: '00000000-0000-4000-8000-000000000001',
      userId: '00000000-0000-4000-8000-000000000002',
      username: 'player-one',
      email: 'player-one@example.test',
      accountStatus: 'active',
      isSelfExcluded: false,
      isCoolingOff: false,
      kycStatus: 'pending',
      rankName: 'Bronze',
      activeCurrency: 'USD',
      syncedAt: '2026-01-02T03:04:05.000Z',
    });
  });

  it('folds an active self-exclusion into the account status', () => {
    const context = toSupportCustomerContext(reading({ isSelfExcluded: true }), NOW);
    expect(context).toMatchObject({ accountStatus: 'self_excluded', isSelfExcluded: true });
  });

  it.each(['suspended', 'closed'] as const)(
    'keeps a %s account its own status under an active self-exclusion',
    (playerStatus) => {
      const context = toSupportCustomerContext(
        reading({ playerStatus, isSelfExcluded: true }),
        NOW,
      );
      expect(context).toMatchObject({ accountStatus: playerStatus, isSelfExcluded: true });
    },
  );

  it.each(['dormant', 'self_excluded'] as const)(
    'keeps a %s status when no self-exclusion is active',
    (playerStatus) => {
      expect(toSupportCustomerContext(reading({ playerStatus }), NOW).accountStatus).toBe(
        playerStatus,
      );
    },
  );

  it('reports a cooling-off without touching the account status', () => {
    const context = toSupportCustomerContext(reading({ isCoolingOff: true }), NOW);
    expect(context).toMatchObject({ accountStatus: 'active', isCoolingOff: true });
  });

  it('normalizes the legacy verified KYC status to approved', () => {
    expect(toSupportCustomerContext(reading({ kycStatus: 'verified' }), NOW).kycStatus).toBe(
      'approved',
    );
  });

  it('passes a missing rank through as null', () => {
    expect(toSupportCustomerContext(reading({ rankName: null }), NOW).rankName).toBeNull();
  });

  it('produces a context the strict schema accepts', () => {
    expect(() =>
      SupportCustomerContextSchema.parse(toSupportCustomerContext(reading(), NOW)),
    ).not.toThrow();
  });
});

describe('syncUntilSettled', () => {
  it('writes once when the context did not move', async () => {
    const written: unknown[] = [];
    await syncUntilSettled(
      async () => toSupportCustomerContext(reading(), new Date()),
      async (context) => {
        written.push(context);
      },
    );
    expect(written).toHaveLength(1);
  });

  it('writes again with the newer context when it moved during the write', async () => {
    const reads = [reading(), reading({ isSelfExcluded: true }), reading({ isSelfExcluded: true })];
    const written: boolean[] = [];
    await syncUntilSettled(
      async () => toSupportCustomerContext(reads.shift() ?? reading(), NOW),
      async (context) => {
        written.push(context.isSelfExcluded);
      },
    );
    expect(written).toEqual([false, true]);
  });

  it('gives up after the extra rounds when the context changes on every read', async () => {
    let read = 0;
    let writes = 0;
    await expect(
      syncUntilSettled(
        async () => toSupportCustomerContext(reading({ rankName: `rank-${read++}` }), NOW),
        async () => {
          writes++;
        },
      ),
    ).rejects.toThrow(SupportContextNotSettledError);
    expect(writes).toBe(1 + MAX_EXTRA_SYNC_ROUNDS);
  });

  it('writes nothing when there is no context to read', async () => {
    let writes = 0;
    await syncUntilSettled(
      async () => null,
      async () => {
        writes++;
      },
    );
    expect(writes).toBe(0);
  });
});
