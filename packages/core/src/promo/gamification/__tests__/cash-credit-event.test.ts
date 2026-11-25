import { describe, it, expect, vi } from 'vitest';
import type { IdentityReader, Uuid } from '@openora/core/contracts';
import type { DrizzleTx, EventBus } from '@openora/core/server';
import { mock } from '../../../testing/mock.js';
import { announceCashCredits } from '../shared/cash-credit-event.js';

const userId = '00000000-0000-4000-8000-000000000001' as Uuid;
const playerId = '00000000-0000-4000-8000-000000000002';

const fakeTx = () => {
  const tx = mock<DrizzleTx>({});
  const select = vi.fn<IdentityReader['getPlayerIdByUserId']>(async () => playerId);
  return { tx, select, identity: mock<IdentityReader>({ getPlayerIdByUserId: select }) };
};

describe('announceCashCredits', () => {
  it('resolves the player once for a multi-currency claim and announces each credit', async () => {
    const { tx, select, identity } = fakeTx();
    const emitInTransaction = vi.fn<EventBus['emitInTransaction']>();

    await announceCashCredits(tx, { events: mock<EventBus>({ emitInTransaction }), identity }, userId, [
      { amount: '1', currency: 'USDT', transactionId: 'tx-1' },
      { amount: '2', currency: 'EUR', transactionId: 'tx-2' },
    ]);

    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith(userId, tx);
    expect(emitInTransaction.mock.calls.map(([, , payload]) => payload)).toEqual([
      expect.objectContaining({ playerId, currency: 'USDT', transactionId: 'tx-1' }),
      expect.objectContaining({ playerId, currency: 'EUR', transactionId: 'tx-2' }),
    ]);
  });

  it('skips replayed credits and does not even look the player up when all are replays', async () => {
    const { tx, select, identity } = fakeTx();
    const emitInTransaction = vi.fn<EventBus['emitInTransaction']>();

    await announceCashCredits(tx, { events: mock<EventBus>({ emitInTransaction }), identity }, userId, [
      { amount: '1', currency: 'USDT', transactionId: null },
    ]);

    expect(select).not.toHaveBeenCalled();
    expect(emitInTransaction).not.toHaveBeenCalled();
  });
});
