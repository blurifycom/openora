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
  TagEvaluationCommands,
  TagKey,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import {
  mock,
  makeEventBus,
  makeIdentityReader,
  NO_CLIENT_META,
  makeAuditWriter,
} from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import {
  wallet,
  walletBalance,
  walletTransaction,
  autoWithdrawalRule,
  walletAutoWithdrawalConfig,
} from '../schema/index.js';
import { WalletService } from '../service/wallet.service.js';

let db: TestDb;

// The migration-level column DEFAULT (0006_lush_morg.sql) - a starting value for
// upgraded installs, not a server-enforced floor. A Super Admin can clear or
// change any of it via setAutoWithdrawalConfig.
const MIGRATION_DEFAULT_EXCLUDE_RISK_FLAGS: readonly TagKey[] = [
  'high_risk',
  'bonus_abuser',
  'kyc_rejected',
  'withdrawal_review',
  'multi_account',
];

type ServiceOptions = {
  autoWithdrawal?: Partial<AutoWithdrawalConfig>;
  // The global fiat/crypto thresholds are DB-backed (BF-211), not part of
  // PlatformConfig any more - seeded into wallet_auto_withdrawal_config here
  // whenever `autoWithdrawal` is passed, mirroring the production seed
  // default ('0'/'0' = auto-approval off until configured).
  fiatThreshold?: string;
  cryptoThreshold?: string;
  // The DB row's tag-exclusion column (BF-319). Undefined = let the column's
  // migration DEFAULT apply (the 5-tag starting value); pass an explicit
  // array (incl. []) to seed exactly that set instead.
  excludeRiskFlags?: readonly TagKey[];
  // Leaves the singleton config row unseeded, to exercise the row-missing
  // fail-closed path.
  skipConfigSeed?: boolean;
  kycStatus?: KycStatus | null;
  directoryThrows?: boolean;
  riskTags?: TagKey[] | 'unbound';
};

async function makeService({
  autoWithdrawal,
  fiatThreshold,
  cryptoThreshold,
  excludeRiskFlags,
  skipConfigSeed = false,
  kycStatus = 'verified',
  directoryThrows = false,
  riskTags = [],
}: ServiceOptions = {}) {
  if (autoWithdrawal && !skipConfigSeed) {
    await db.drizzle.db.insert(walletAutoWithdrawalConfig).values({
      singletonKey: 'global',
      fiatThreshold: fiatThreshold ?? '0',
      cryptoThreshold: cryptoThreshold ?? '0',
      ...(excludeRiskFlags !== undefined ? { excludeRiskFlags: [...excludeRiskFlags] } : {}),
    });
  }
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
    autoWithdrawal ? { autoWithdrawal: { enabled: true, ...autoWithdrawal } } : {},
  );
  const svc = new WalletService({
    drizzle: db.drizzle,
    events: events,
    payment: mock<PaymentAdapter>(psp),
    audit: mock<AuditWritePort>(audit),
    identityReader: makeIdentityReader(),
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
  await db.drizzle.db
    .insert(walletBalance)
    .values({ walletId: row!.id, currency: row!.currency, amount: row!.balance });
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
  db = await createTestDb([migrate, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${walletTransaction}, ${autoWithdrawalRule}, ${walletAutoWithdrawalConfig}, ${wallet} RESTART IDENTITY CASCADE`,
  );
});

describe('WalletService.withdraw auto-approval (real PG)', () => {
  it('auto-approves a fiat withdrawal that clears every gate, marking the system as reviewer', async () => {
    const { svc, psp, audit, events } = await makeService({
      autoWithdrawal: {},
      fiatThreshold: '1000',
    });
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
          threshold: '1000.000000000000000000',
          thresholdSource: 'global',
          kycStatus: 'verified',
          cumulativeCountUsed: 0,
        }),
      }),
    );
  });

  it('reverts the flip to pending when the audit write fails instead of stranding it processing', async () => {
    const { svc, audit, psp } = await makeService({ autoWithdrawal: {}, fiatThreshold: '1000' });
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
    const { svc } = await makeService({ autoWithdrawal: {}, fiatThreshold: '10' });
    const w = await seedWallet({ balance: '100' });

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '40',
      currency: 'USD',
      ...NO_CLIENT_META,
    });

    expect(result.status).toBe('pending');
    const [row] = await db.drizzle.db
      .select()
      .from(walletBalance)
      .where(eq(walletBalance.walletId, w.id));
    expect(Number(row?.amount)).toBe(60);
  });

  it('stays pending when the amount exceeds the configured threshold', async () => {
    const { svc, psp } = await makeService({ autoWithdrawal: {}, fiatThreshold: '10' });
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
    const { svc } = await makeService({ autoWithdrawal: {} });
    const w = await seedWallet();

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '40',
      currency: 'USD',
      ...NO_CLIENT_META,
    });

    expect(result.status).toBe('pending');
  });

  it('stays pending, without throwing, when the auto-withdrawal config row is missing entirely', async () => {
    const { svc } = await makeService({
      autoWithdrawal: {},
      fiatThreshold: '1000',
      skipConfigSeed: true,
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

  it('stays pending when auto-withdrawal is not enabled', async () => {
    const { svc, audit } = await makeService();
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
    const { svc } = await makeService({
      autoWithdrawal: {},
      fiatThreshold: '1000',
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
    const { svc } = await makeService({
      autoWithdrawal: {},
      fiatThreshold: '1000',
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
    const { svc } = await makeService({
      autoWithdrawal: {},
      fiatThreshold: '1000',
      excludeRiskFlags: ['bonus_abuser'],
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

  it('awaits the synchronous tag evaluation (TAG_EVALUATION_COMMANDS) before reading risk tags, so a withdrawal_review assignment it makes is honored by auto-approval instead of raced by the async event handler', async () => {
    const callOrder: string[] = [];
    // Stands in for TagEvaluationService.evaluateWithdrawalRequested committing a
    // withdrawal_review assignment on the caller's own tx (see wallet.service.ts's
    // withdraw()) - by the time this resolves, the tag must be visible to any later read.
    const assignedTags = new Set<TagKey>();
    const tagEvaluationCommands = mock<TagEvaluationCommands>({
      evaluateWithdrawalRequested: vi.fn(async () => {
        callOrder.push('evaluateWithdrawalRequested');
        assignedTags.add('withdrawal_review');
      }),
    });
    const riskTags = mock<PlayerTags>({
      getActiveTagKeys: vi.fn(async (ids: readonly string[]) => {
        callOrder.push('getActiveTagKeys');
        return new Map(ids.map((id) => [id, [...assignedTags]]));
      }),
    });
    const directory = mock<AdminUserDirectory>({
      lookupPlayers: vi.fn(async (ids: string[]) =>
        ids.map((userId) =>
          mock<AdminPlayerSummary>({ userId, username: 'player', kycStatus: 'verified' }),
        ),
      ),
    });
    await db.drizzle.db.insert(walletAutoWithdrawalConfig).values({
      singletonKey: 'global',
      fiatThreshold: '1000',
      cryptoThreshold: '0',
      excludeRiskFlags: ['withdrawal_review'],
    });
    const platformConfig = mock<PlatformConfig>({
      autoWithdrawal: {
        enabled: true,
      },
    });
    const payment = mock<PaymentAdapter>({
      processWithdrawal: vi.fn(async () => ({
        externalId: randomUUID(),
        status: 'completed' as const,
      })),
    });
    const svc = new WalletService({
      drizzle: db.drizzle,
      events: makeEventBus(),
      payment,
      audit: mock<AuditWritePort>(makeAuditWriter()),
      identityReader: makeIdentityReader(),
      directory,
      platformConfig,
      riskTags,
      tagEvaluationCommands,
    });
    const w = await seedWallet();

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '40',
      currency: 'USD',
      ...NO_CLIENT_META,
    });

    // Ordering proof: the synchronous command-port call happened, and completed, before
    // auto-approval's risk-tag read - never the reverse, and never concurrent/unawaited.
    expect(callOrder).toEqual(['evaluateWithdrawalRequested', 'getActiveTagKeys']);
    expect(tagEvaluationCommands.evaluateWithdrawalRequested).toHaveBeenCalledWith(
      expect.anything(),
      { userId: w.userId, amount: '40' },
    );
    // Causality proof: auto-approval saw the tag the synchronous call just assigned and
    // declined to pay out - the exact race the fire-and-forget event emit alone could lose.
    expect(result.status).toBe('pending');
    expect(payment.processWithdrawal).not.toHaveBeenCalled();
  });

  it('auto-approves when the player carries only unrelated tags', async () => {
    const { svc } = await makeService({
      autoWithdrawal: {},
      fiatThreshold: '1000',
      // Explicit empty array proves the exclusion set is genuinely empty here,
      // not the column's non-empty DB default leaking through.
      excludeRiskFlags: [],
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
    const { svc } = await makeService({
      autoWithdrawal: {},
      fiatThreshold: '1000',
      excludeRiskFlags: ['bonus_abuser'],
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

  it('setAutoWithdrawalConfig clearing excludeRiskFlags to [] lets a high_risk-tagged player auto-approve', async () => {
    const { svc } = await makeService({
      autoWithdrawal: {},
      fiatThreshold: '1000',
      riskTags: ['high_risk'],
    });
    await svc.setAutoWithdrawalConfig(randomUUID(), {
      fiatThreshold: '1000',
      cryptoThreshold: '0',
      excludeRiskFlags: [],
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

  it('a per-player auto_withdrawal_rule override that clears the threshold gate does NOT bypass the tag-exclusion gate - a tag-excluded player still stays pending', async () => {
    const { svc } = await makeService({
      autoWithdrawal: {},
      fiatThreshold: '10',
      riskTags: ['kyc_rejected'],
    });
    const w = await seedWallet();
    await svc.setAutoWithdrawalRule({
      userId: w.userId,
      threshold: '1000',
      reason: 'trusted, but still carries an excluded tag',
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

  it('an upgraded install with a pre-existing config row (no explicit excludeRiskFlags) gets the migration DEFAULT tags without any admin edit', async () => {
    const { svc } = await makeService({ autoWithdrawal: {}, fiatThreshold: '1000' });

    const config = await svc.getAutoWithdrawalConfig();

    expect(new Set(config.excludeRiskFlags)).toEqual(new Set(MIGRATION_DEFAULT_EXCLUDE_RISK_FLAGS));
  });

  it('stays pending on the large_amount heuristic regardless of the threshold', async () => {
    const { svc } = await makeService({ autoWithdrawal: {}, fiatThreshold: '100000' });
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
    const { svc } = await makeService({ autoWithdrawal: {}, fiatThreshold: '1000' });
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
    const { svc } = await makeService({ autoWithdrawal: {}, fiatThreshold: '1000' });
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
    const { svc } = await makeService({
      autoWithdrawal: { dailyCapCount: 1 },
      fiatThreshold: '1000',
    });
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
    const { svc } = await makeService({
      autoWithdrawal: { dailyCapAmount: '50' },
      fiatThreshold: '1000',
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
    const { svc } = await makeService({
      autoWithdrawal: { dailyCapCount: 1 },
      fiatThreshold: '1000',
    });
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
    const { svc } = await makeService({
      autoWithdrawal: { dailyCapCount: 1 },
      fiatThreshold: '1000',
    });
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
    const { svc } = await makeService({ autoWithdrawal: {}, fiatThreshold: '1000' });
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
    const { svc } = await makeService({ autoWithdrawal: {}, cryptoThreshold: '2' });
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
    const { svc } = await makeService({ autoWithdrawal: {}, cryptoThreshold: '0.5' });
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
    const { svc } = await makeService({
      autoWithdrawal: {},
      cryptoThreshold: '2',
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
    const { svc } = await makeService({ autoWithdrawal: {}, fiatThreshold: '1000' });
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
    const { svc, audit } = await makeService({ autoWithdrawal: {}, fiatThreshold: '10' });
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

  it('stays pending for a player with a per-player override when the global config row is missing (fail-closed)', async () => {
    const { svc } = await makeService({
      autoWithdrawal: {},
      fiatThreshold: '1000',
      skipConfigSeed: true,
    });
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

    expect(result.status).toBe('pending');
  });

  it('a per-player rule overrides the crypto threshold too', async () => {
    const { svc } = await makeService({ autoWithdrawal: {}, cryptoThreshold: '0.5' });
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
    const { svc } = await makeService({ autoWithdrawal: {}, fiatThreshold: '1000' });
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
    const { svc } = await makeService();
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
    const { svc } = await makeService();

    expect(await svc.getAutoWithdrawalRule(randomUUID())).toBeNull();
  });

  it('getAutoWithdrawalRule serializes the timestamps as ISO strings', async () => {
    const { svc } = await makeService();
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
    const { svc } = await makeService();
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

describe('WalletService auto-withdrawal config methods (real PG)', () => {
  it('setAutoWithdrawalConfig updates the singleton row and stamps the admin', async () => {
    const { svc } = await makeService({ autoWithdrawal: {} });
    const adminId = randomUUID();

    const updated = await svc.setAutoWithdrawalConfig(adminId, {
      fiatThreshold: '2500',
      cryptoThreshold: '3',
      excludeRiskFlags: ['bonus_abuser'],
    });

    expect(updated.fiatThreshold).toBe('2500.000000000000000000');
    expect(updated.cryptoThreshold).toBe('3.000000000000000000');
    expect(updated.excludeRiskFlags).toEqual(['bonus_abuser']);
    expect(updated.updatedBy).toBe(adminId);
    expect(await svc.getAutoWithdrawalConfig()).toMatchObject({
      fiatThreshold: '2500.000000000000000000',
      cryptoThreshold: '3.000000000000000000',
      updatedBy: adminId,
    });
  });

  it('getAutoWithdrawalConfig throws a typed not-found error when the singleton row is missing', async () => {
    const { svc } = await makeService();

    await expect(svc.getAutoWithdrawalConfig()).rejects.toThrow();
  });
});
