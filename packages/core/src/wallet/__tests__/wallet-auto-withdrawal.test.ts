import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type {
  AdminUserDirectory,
  AuditWritePort,
  AutoWithdrawalConfig,
  KycStatus,
  PaymentAdapter,
  PlatformConfig,
  AdminPlayerSummary,
  PlayerTags,
  TagKey,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { mock, makeEventBus, NO_CLIENT_META, makeAuditWriter } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { wallet, walletTransaction, autoWithdrawalRule } from '../schema/index.js';
import { WalletService } from '../service/wallet.service.js';

let db: TestDb;

type ServiceOptions = {
  autoWithdrawal?: Partial<AutoWithdrawalConfig>;
  kycStatus?: KycStatus | null;
  directoryThrows?: boolean;
  riskTags?: TagKey[] | 'unbound';
};

function makeService({
  autoWithdrawal,
  kycStatus = 'verified',
  directoryThrows = false,
  riskTags = [],
}: ServiceOptions = {}) {
  const events = makeEventBus();
  const psp = {
    processWithdrawal: vi.fn(async () => ({
      externalId: randomUUID(),
      status: 'completed' as const,
    })),
  };
  const audit = makeAuditWriter();
  const directory = mock<AdminUserDirectory>({
    lookupPlayers: vi.fn(async (ids: string[]) => {
      if (directoryThrows) {
        throw new Error('directory down');
      }
      return kycStatus
        ? ids.map((userId) => mock<AdminPlayerSummary>({ userId, username: 'player', kycStatus }))
        : [];
    }),
  });
  const platformConfig = mock<PlatformConfig>(
    autoWithdrawal
      ? { autoWithdrawal: { enabled: true, excludeRiskFlags: [], ...autoWithdrawal } }
      : {},
  );
  const svc = new WalletService({
    drizzle: db.drizzle,
    events: events,
    payment: mock<PaymentAdapter>(psp),
    audit: mock<AuditWritePort>(audit),
    directory,
    platformConfig,
    ...(riskTags === 'unbound'
      ? {}
      : {
          riskTags: mock<PlayerTags>({
            getActiveTagKeys: vi.fn(
              async (ids: readonly string[]) => new Map(ids.map((id) => [id, riskTags])),
            ),
          }),
        }),
  });
  return { svc, events, psp, audit };
}

async function seedWallet(overrides: Partial<typeof wallet.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(wallet)
    .values({ userId: randomUUID(), balance: '100000', currency: 'USD', ...overrides })
    .returning();
  return row!;
}

async function txById(id: string) {
  const [row] = await db.drizzle.db
    .select()
    .from(walletTransaction)
    .where(eq(walletTransaction.id, id));
  return row!;
}

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${walletTransaction}, ${autoWithdrawalRule}, ${wallet} RESTART IDENTITY CASCADE`,
  );
});

describe('WalletService.withdraw auto-approval (real PG)', () => {
  it('auto-approves a fiat withdrawal that clears every gate, marking the system as reviewer', async () => {
    const { svc, psp, audit, events } = makeService({ autoWithdrawal: { fiatThreshold: '1000' } });
    const w = await seedWallet();

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '40',
      currency: 'USD',
      ...NO_CLIENT_META,
    });

    expect(result.status).toBe('completed');
    expect(psp.processWithdrawal).toHaveBeenCalledTimes(1);
    expect(await txById(result.transactionId)).toMatchObject({
      status: 'completed',
      reviewedBy: null,
      reviewReason: 'auto-approved',
      providerName: 'psp',
    });
    expect(events.emit.mock.calls.map(([topic]) => topic)).toEqual([
      'wallet.withdrawal.requested',
      'wallet.withdrawal.completed',
    ]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'system',
        action: 'wallet.withdrawal.auto_approved',
        resourceType: 'wallet_transaction',
        resourceId: result.transactionId,
        after: expect.objectContaining({
          threshold: '1000',
          thresholdSource: 'global',
          kycStatus: 'verified',
          cumulativeCountUsed: 0,
        }),
      }),
    );
  });

  it('reverts the flip to pending when the audit write fails instead of stranding it processing', async () => {
    const { svc, audit, psp } = makeService({ autoWithdrawal: { fiatThreshold: '1000' } });
    audit.record.mockRejectedValueOnce(new Error('audit sink down'));
    const w = await seedWallet();

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '40',
      currency: 'USD',
      ...NO_CLIENT_META,
    });

    expect(result.status).toBe('pending');
    expect(psp.processWithdrawal).not.toHaveBeenCalled();
    expect(await txById(result.transactionId)).toMatchObject({
      status: 'pending',
      reviewedBy: null,
      reviewedAt: null,
      reviewReason: null,
    });
  });

  it('holds the funds even when auto-approval declines', async () => {
    const { svc } = makeService({ autoWithdrawal: { fiatThreshold: '10' } });
    const w = await seedWallet({ balance: '100' });

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '40',
      currency: 'USD',
      ...NO_CLIENT_META,
    });

    expect(result.status).toBe('pending');
    const [row] = await db.drizzle.db.select().from(wallet).where(eq(wallet.id, w.id));
    expect(Number(row?.balance)).toBe(60);
  });

  it('stays pending when the amount exceeds the configured threshold', async () => {
    const { svc, psp } = makeService({ autoWithdrawal: { fiatThreshold: '10' } });
    const w = await seedWallet();

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '40',
      currency: 'USD',
      ...NO_CLIENT_META,
    });

    expect(result.status).toBe('pending');
    expect(psp.processWithdrawal).not.toHaveBeenCalled();
  });

  it('stays pending when no threshold is configured at all', async () => {
    const { svc } = makeService({ autoWithdrawal: {} });
    const w = await seedWallet();

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '40',
      currency: 'USD',
      ...NO_CLIENT_META,
    });

    expect(result.status).toBe('pending');
  });

  it('stays pending when auto-withdrawal is not enabled', async () => {
    const { svc, audit } = makeService();
    const w = await seedWallet();

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '40',
      currency: 'USD',
      ...NO_CLIENT_META,
    });

    expect(result.status).toBe('pending');
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('stays pending when KYC is not passing even though gateWithdrawals is off', async () => {
    const { svc } = makeService({
      autoWithdrawal: { fiatThreshold: '1000' },
      kycStatus: 'pending',
    });
    const w = await seedWallet();

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '40',
      currency: 'USD',
      ...NO_CLIENT_META,
    });

    expect(result.status).toBe('pending');
  });

  it('fails closed to pending when the directory throws during the KYC check', async () => {
    const { svc } = makeService({
      autoWithdrawal: { fiatThreshold: '1000' },
      directoryThrows: true,
    });
    const w = await seedWallet();

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '40',
      currency: 'USD',
      ...NO_CLIENT_META,
    });

    expect(result.status).toBe('pending');
  });

  it('stays pending when the player carries an excluded risk flag', async () => {
    const { svc } = makeService({
      autoWithdrawal: { fiatThreshold: '1000', excludeRiskFlags: ['bonus_abuser'] },
      riskTags: ['bonus_abuser'],
    });
    const w = await seedWallet();

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '40',
      currency: 'USD',
      ...NO_CLIENT_META,
    });

    expect(result.status).toBe('pending');
  });

  it('auto-approves when the player carries only unrelated tags', async () => {
    const { svc } = makeService({
      autoWithdrawal: { fiatThreshold: '1000', excludeRiskFlags: ['bonus_abuser'] },
      riskTags: ['vip'],
    });
    const w = await seedWallet();

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '40',
      currency: 'USD',
      ...NO_CLIENT_META,
    });

    expect(result.status).toBe('completed');
  });

  it('fails closed to pending when risk flags are configured but the tags port is unbound', async () => {
    const { svc } = makeService({
      autoWithdrawal: { fiatThreshold: '1000', excludeRiskFlags: ['bonus_abuser'] },
      riskTags: 'unbound',
    });
    const w = await seedWallet();

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '40',
      currency: 'USD',
      ...NO_CLIENT_META,
    });

    expect(result.status).toBe('pending');
  });

  it('stays pending on the large_amount heuristic regardless of the threshold', async () => {
    const { svc } = makeService({ autoWithdrawal: { fiatThreshold: '100000' } });
    const w = await seedWallet();

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '5000',
      currency: 'USD',
      ...NO_CLIENT_META,
    });

    expect(result.status).toBe('pending');
  });

  it('stays pending once the wallet hits the high_frequency velocity flag', async () => {
    const { svc } = makeService({ autoWithdrawal: { fiatThreshold: '1000' } });
    const w = await seedWallet();
    await db.drizzle.db.insert(walletTransaction).values([
      { walletId: w.id, type: 'withdrawal', amount: '1', currency: 'USD', status: 'completed' },
      { walletId: w.id, type: 'withdrawal', amount: '1', currency: 'USD', status: 'completed' },
    ]);

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '40',
      currency: 'USD',
      ...NO_CLIENT_META,
    });

    expect(result.status).toBe('pending');
  });

  it('ignores withdrawals outside the velocity window', async () => {
    const { svc } = makeService({ autoWithdrawal: { fiatThreshold: '1000' } });
    const w = await seedWallet();
    const outsideWindow = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await db.drizzle.db.insert(walletTransaction).values([
      {
        walletId: w.id,
        type: 'withdrawal',
        amount: '1',
        currency: 'USD',
        status: 'completed',
        createdAt: outsideWindow,
      },
      {
        walletId: w.id,
        type: 'withdrawal',
        amount: '1',
        currency: 'USD',
        status: 'completed',
        createdAt: outsideWindow,
      },
    ]);

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '40',
      currency: 'USD',
      ...NO_CLIENT_META,
    });

    expect(result.status).toBe('completed');
  });

  it('stays pending when a configured daily count cap would be exceeded', async () => {
    const { svc } = makeService({ autoWithdrawal: { fiatThreshold: '1000', dailyCapCount: 1 } });
    const w = await seedWallet();
    await db.drizzle.db.insert(walletTransaction).values({
      walletId: w.id,
      type: 'withdrawal',
      amount: '10',
      currency: 'USD',
      status: 'completed',
      reviewReason: 'auto-approved',
    });

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '40',
      currency: 'USD',
      ...NO_CLIENT_META,
    });

    expect(result.status).toBe('pending');
  });

  it('stays pending when a configured daily amount cap would be exceeded', async () => {
    const { svc } = makeService({
      autoWithdrawal: { fiatThreshold: '1000', dailyCapAmount: '50' },
    });
    const w = await seedWallet();
    await db.drizzle.db.insert(walletTransaction).values({
      walletId: w.id,
      type: 'withdrawal',
      amount: '20',
      currency: 'USD',
      status: 'completed',
      reviewReason: 'auto-approved',
    });

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '40',
      currency: 'USD',
      ...NO_CLIENT_META,
    });

    expect(result.status).toBe('pending');
  });

  it('counts only auto-approved payouts towards the daily cap', async () => {
    const { svc } = makeService({ autoWithdrawal: { fiatThreshold: '1000', dailyCapCount: 1 } });
    const w = await seedWallet();
    await db.drizzle.db.insert(walletTransaction).values({
      walletId: w.id,
      type: 'withdrawal',
      amount: '10',
      currency: 'USD',
      status: 'completed',
      reviewReason: 'manual sign-off',
    });

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '40',
      currency: 'USD',
      ...NO_CLIENT_META,
    });

    expect(result.status).toBe('completed');
  });

  it('serializes concurrent withdrawals so a count cap of one cannot be bypassed', async () => {
    const { svc } = makeService({ autoWithdrawal: { fiatThreshold: '1000', dailyCapCount: 1 } });
    const w = await seedWallet();

    const results = await Promise.all([
      svc.withdraw({ userId: w.userId, amount: '40', currency: 'USD', ...NO_CLIENT_META }),
      svc.withdraw({ userId: w.userId, amount: '41', currency: 'USD', ...NO_CLIENT_META }),
    ]);

    expect(results.filter((r) => r.status === 'completed')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'pending')).toHaveLength(1);
  });
});

describe('WalletService.withdraw auto-approval - crypto rail (real PG)', () => {
  it('stays pending when no cryptoThreshold is configured, even with a fiat one', async () => {
    const { svc } = makeService({ autoWithdrawal: { fiatThreshold: '1000' } });
    const w = await seedWallet({ currency: 'BTC', balance: '10' });

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '1',
      currency: 'BTC',
      destinationAddress: 'bc1qexample',
      ...NO_CLIENT_META,
    });

    expect(result.status).toBe('pending');
  });

  it('auto-approves once an operator configures a positive cryptoThreshold', async () => {
    const { svc } = makeService({ autoWithdrawal: { cryptoThreshold: '2' } });
    const w = await seedWallet({ currency: 'BTC', balance: '10' });

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '1',
      currency: 'BTC',
      destinationAddress: 'bc1qexample',
      ...NO_CLIENT_META,
    });

    expect(result.status).toBe('completed');
    expect(await txById(result.transactionId)).toMatchObject({
      rail: 'crypto',
      providerName: 'fireblocks',
      reviewReason: 'auto-approved',
    });
  });

  it('stays pending when the crypto amount exceeds cryptoThreshold', async () => {
    const { svc } = makeService({ autoWithdrawal: { cryptoThreshold: '0.5' } });
    const w = await seedWallet({ currency: 'BTC', balance: '10' });

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '1',
      currency: 'BTC',
      destinationAddress: 'bc1qexample',
      ...NO_CLIENT_META,
    });

    expect(result.status).toBe('pending');
  });

  it('applies the same KYC guard as the fiat rail', async () => {
    const { svc } = makeService({
      autoWithdrawal: { cryptoThreshold: '2' },
      kycStatus: 'rejected',
    });
    const w = await seedWallet({ currency: 'BTC', balance: '10' });

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '1',
      currency: 'BTC',
      destinationAddress: 'bc1qexample',
      ...NO_CLIENT_META,
    });

    expect(result.status).toBe('pending');
  });
});

describe('WalletService auto-approval threshold resolution (real PG)', () => {
  it('a per-player rule below the global threshold blocks what global would allow', async () => {
    const { svc } = makeService({ autoWithdrawal: { fiatThreshold: '1000' } });
    const w = await seedWallet();
    await svc.setAutoWithdrawalRule({
      userId: w.userId,
      threshold: '10',
      reason: 'watchlist',
      createdBy: randomUUID(),
    });

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '40',
      currency: 'USD',
      ...NO_CLIENT_META,
    });

    expect(result.status).toBe('pending');
  });

  it('a per-player rule above the global threshold allows what global would block', async () => {
    const { svc, audit } = makeService({ autoWithdrawal: { fiatThreshold: '10' } });
    const w = await seedWallet();
    await svc.setAutoWithdrawalRule({
      userId: w.userId,
      threshold: '1000',
      reason: 'trusted',
      createdBy: randomUUID(),
    });

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '40',
      currency: 'USD',
      ...NO_CLIENT_META,
    });

    expect(result.status).toBe('completed');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        after: expect.objectContaining({ thresholdSource: 'per-player' }),
      }),
    );
  });

  it('a per-player rule overrides the crypto threshold too', async () => {
    const { svc } = makeService({ autoWithdrawal: { cryptoThreshold: '0.5' } });
    const w = await seedWallet({ currency: 'BTC', balance: '10' });
    await svc.setAutoWithdrawalRule({
      userId: w.userId,
      threshold: '5',
      reason: 'trusted',
      createdBy: randomUUID(),
    });

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '1',
      currency: 'BTC',
      destinationAddress: 'bc1qexample',
      ...NO_CLIENT_META,
    });

    expect(result.status).toBe('completed');
  });

  it('a zero per-player threshold turns auto-approval off for that player', async () => {
    const { svc } = makeService({ autoWithdrawal: { fiatThreshold: '1000' } });
    const w = await seedWallet();
    await svc.setAutoWithdrawalRule({
      userId: w.userId,
      threshold: '0',
      reason: 'manual only',
      createdBy: randomUUID(),
    });

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '40',
      currency: 'USD',
      ...NO_CLIENT_META,
    });

    expect(result.status).toBe('pending');
  });
});

describe('WalletService auto-withdrawal rule methods (real PG)', () => {
  it('setAutoWithdrawalRule inserts, then upserts on a repeat for the same player', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    const createdBy = randomUUID();

    const created = await svc.setAutoWithdrawalRule({
      userId,
      threshold: '500',
      reason: 'initial',
      createdBy,
    });
    const updated = await svc.setAutoWithdrawalRule({
      userId,
      threshold: '750',
      reason: 'raised',
      createdBy,
    });

    expect(created.id).toBe(updated.id);
    expect(Number(updated.threshold)).toBe(750);
    expect(updated.reason).toBe('raised');
    const rows = await db.drizzle.db
      .select()
      .from(autoWithdrawalRule)
      .where(eq(autoWithdrawalRule.userId, userId));
    expect(rows).toHaveLength(1);
  });

  it('getAutoWithdrawalRule returns null when no rule exists', async () => {
    const { svc } = makeService();

    expect(await svc.getAutoWithdrawalRule(randomUUID())).toBeNull();
  });

  it('getAutoWithdrawalRule serializes the timestamps as ISO strings', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await svc.setAutoWithdrawalRule({
      userId,
      threshold: '500',
      reason: 'initial',
      createdBy: randomUUID(),
    });

    const rule = await svc.getAutoWithdrawalRule(userId);

    expect(rule?.createdAt).toBe(new Date(rule?.createdAt ?? '').toISOString());
  });

  it('deleteAutoWithdrawalRule reports whether a row was removed', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await svc.setAutoWithdrawalRule({
      userId,
      threshold: '500',
      reason: 'initial',
      createdBy: randomUUID(),
    });

    expect(await svc.deleteAutoWithdrawalRule(userId)).toBe(true);
    expect(await svc.deleteAutoWithdrawalRule(userId)).toBe(false);
    expect(await svc.getAutoWithdrawalRule(userId)).toBeNull();
  });
});
