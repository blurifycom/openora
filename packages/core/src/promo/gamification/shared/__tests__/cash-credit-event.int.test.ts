import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IdentityReader, Uuid } from '@openora/core/contracts';
import type { EventBus } from '@openora/core/server';
import { createTestDb, type TestDb } from '../../../../testing/index.js';
import { announceCashCredits } from '../cash-credit-event.js';

const userId = '00000000-0000-4000-8000-000000000001' as Uuid;
const playerId = '00000000-0000-4000-8000-000000000002' as Uuid;

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb([]);
}, 120_000);

afterAll(() => testDb.drop());

function recordingIdentity() {
  const lookups: { userId: string; tx: unknown }[] = [];
  const identity: IdentityReader = {
    getLastLoginAt: async () => null,
    getPlayerIdsInactiveSince: async () => [],
    getPlayerIdByUserId: async (id, tx) => {
      lookups.push({ userId: id, tx });
      return playerId;
    },
    getPlayerIdByUserIdSafe: async () => playerId,
    getPlayerIdsByUserIdsSafe: async () => new Map(),
    getPlayerKycStatusByUserId: async () => null,
    getPlayerUserIdsSharingLoginIp: async () => [],
  };
  return { identity, lookups };
}

function recordingEvents() {
  const emitted: { topic: string; payload: unknown }[] = [];
  const events: EventBus = {
    emit() {},
    emitRaw() {},
    emitInTransaction: async (_tx, topic, payload) => {
      emitted.push({ topic, payload });
    },
    on: () => () => {},
    tapTransactional() {},
  };
  return { events, emitted };
}

describe('announceCashCredits', () => {
  it('resolves the player once on the caller transaction and announces each credit', async () => {
    const { identity, lookups } = recordingIdentity();
    const { events, emitted } = recordingEvents();

    await testDb.drizzle.db.transaction(async (tx) => {
      await announceCashCredits(tx, { events, identity }, userId, [
        { amount: '1', currency: 'USDT', transactionId: 'tx-1' },
        { amount: '2', currency: 'EUR', transactionId: 'tx-2' },
      ]);
      expect(lookups).toEqual([{ userId, tx }]);
    });

    expect(emitted.map(({ topic }) => topic)).toEqual(['wallet.balance.changed', 'wallet.balance.changed']);
    expect(emitted.map(({ payload }) => payload)).toEqual([
      expect.objectContaining({ playerId, currency: 'USDT', transactionId: 'tx-1' }),
      expect.objectContaining({ playerId, currency: 'EUR', transactionId: 'tx-2' }),
    ]);
  });

  it('skips replayed credits and never looks the player up when all are replays', async () => {
    const { identity, lookups } = recordingIdentity();
    const { events, emitted } = recordingEvents();

    await testDb.drizzle.db.transaction((tx) =>
      announceCashCredits(tx, { events, identity }, userId, [
        { amount: '1', currency: 'USDT', transactionId: null },
      ]),
    );

    expect(lookups).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it('announces only the credits that moved in a mixed batch', async () => {
    const { identity, lookups } = recordingIdentity();
    const { events, emitted } = recordingEvents();

    await testDb.drizzle.db.transaction((tx) =>
      announceCashCredits(tx, { events, identity }, userId, [
        { amount: '1', currency: 'USDT', transactionId: null },
        { amount: '2', currency: 'EUR', transactionId: 'tx-2' },
      ]),
    );

    expect(lookups).toHaveLength(1);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.payload).toMatchObject({ currency: 'EUR', transactionId: 'tx-2' });
  });
});
