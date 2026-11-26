import { randomUUID } from 'node:crypto';
import { and, eq, like } from 'drizzle-orm';
import { createEventBus, DrizzleOutboxWriter, type EventBus } from '@openora/core/server';
import { migrate as migrateEngine } from '@openora/core/server/migrate';
import type {
  MessageBrokerAdapter,
  SportsbookLedgerApplied,
  SportsbookLedgerOutcome,
  SportsbookReserveArgs,
} from '@openora/core/contracts';
import { migrate as migrateIdentity } from '../pam/identity/migrate.js';
import { migrate as migrateProfile } from '../pam/profile/migrate.js';
import { IdentityReaderService } from '../pam/identity/adapters/identity-reader.service.js';
import { migrate as migrateWallet } from '../wallet/migrate.js';
import { WalletCommandsService } from '../wallet/service/wallet-commands.service.js';
import { LedgerPlayEligibilityService } from '../wallet/service/ledger-play-eligibility.service.js';
import { WalletReaderService } from '../wallet/adapters/wallet-reader.service.js';
import {
  ledgerPlayEligibility,
  wallet,
  walletBalance,
  walletTransaction,
} from '../wallet/schema/index.js';
import { migrate as migrateAudit } from '../audit/migrate.js';
import { AuditService } from '../audit/service/audit.service.js';
import { createTestDb, type TestDb } from './real-infra.js';
import { seedPlayerWithUser } from './seed-player.js';
import { migrate as migrateBetting } from '../sportsbook/betting/migrate.js';
import { SportsbookConfigService } from '../sportsbook/betting/service/config.service.js';
import { SportsbookDebtService } from '../sportsbook/betting/service/debt.service.js';
import { SportsbookSessionService } from '../sportsbook/betting/service/session.service.js';
import { SportsbookLedgerService } from '../sportsbook/betting/service/ledger.service.js';
import { SportsbookAlignService } from '../sportsbook/betting/service/align.service.js';
import { SportsbookReconcileService } from '../sportsbook/betting/service/reconcile.service.js';
import { sportsbookConfig, sportsbookSession } from '../sportsbook/betting/schema/index.js';

export const PROVIDER = 'int-provider';

const inertBroker: MessageBrokerAdapter = {
  publish: () => undefined,
  subscribe: () => () => undefined,
  close: () => Promise.resolve(),
};

export type LedgerHarness = Awaited<ReturnType<typeof bootLedger>>;

export async function bootLedger() {
  const testDb = await createTestDb([
    migrateEngine,
    migrateIdentity,
    migrateProfile,
    migrateWallet,
    migrateAudit,
    migrateBetting,
  ]);
  const { drizzle } = testDb;
  const events: EventBus = createEventBus({
    broker: inertBroker,
    outbox: new DrizzleOutboxWriter(),
    processedEvents: { has: () => Promise.resolve(false), record: () => Promise.resolve() },
  });
  const identity = new IdentityReaderService(drizzle);
  const audit = new AuditService(drizzle, events, identity);
  const playEligibility = new LedgerPlayEligibilityService(drizzle);
  const walletReader = new WalletReaderService({ drizzle, pivotCurrency: 'USD' });
  const walletCommands = new WalletCommandsService(playEligibility, audit, {
    identityReader: identity,
  });
  const config = new SportsbookConfigService(drizzle, audit);
  const debts = new SportsbookDebtService({
    drizzle,
    events,
    audit,
    identity,
    wallet: walletCommands,
    walletReader,
  });
  const sessions = new SportsbookSessionService({
    drizzle,
    audit,
    config,
    playEligibility,
    walletReader,
  });
  const ledger = new SportsbookLedgerService({
    drizzle,
    events,
    audit,
    config,
    sessions,
    debts,
    playEligibility,
    identity,
    wallet: walletCommands,
    walletReader,
  });
  const align = new SportsbookAlignService({ drizzle, ledger, audit });
  const reconcile = new SportsbookReconcileService(drizzle, config, align);
  await drizzle.db.insert(sportsbookConfig).values({
    enabled: true,
    currencies: [{ currency: 'USD', decimals: 2 }],
    promotions: { enabled: true, maxPromotionStakeUsd: null, funder: {} },
  });
  return { testDb, ledger, debts, reconcile };
}

export const money = (amount: number | string) => {
  const [whole, fraction = ''] = String(amount).split('.');
  return `${whole}.${fraction.padEnd(18, '0')}`;
};

export const txId = () => `tx-${randomUUID()}`;

export async function seedBettor(testDb: TestDb, amount: string) {
  const { db } = testDb.drizzle;
  const { account } = await seedPlayerWithUser(testDb);
  const userId = account.id;
  await db.insert(ledgerPlayEligibility).values({
    userId,
    rgBlocked: false,
    isActive: true,
    banned: false,
    status: 'active',
    version: 1,
  });
  const [owned] = await db.insert(wallet).values({ userId, currency: 'USD' }).returning();
  if (!owned) {
    throw new Error('the wallet insert returned no row');
  }
  await db.insert(walletBalance).values({ walletId: owned.id, currency: 'USD', amount });
  const [session] = await db
    .insert(sportsbookSession)
    .values({
      userId,
      provider: PROVIDER,
      currency: 'USD',
      countryCode: 'PL',
      expiresAt: new Date(Date.now() + 3_600_000),
      providerOpenedAt: new Date(),
    })
    .returning();
  if (!session) {
    throw new Error('the session insert returned no row');
  }
  return { userId, walletId: owned.id, sessionId: session.id };
}

export function reserveArgs(
  sessionId: string,
  overrides: Partial<SportsbookReserveArgs> = {},
): SportsbookReserveArgs {
  return {
    provider: PROVIDER,
    providerTxId: txId(),
    providerBetId: `bet-${randomUUID()}`,
    sessionId,
    currency: 'USD',
    stake: '10',
    potentialPayout: '25',
    legs: [{ eventId: 'event-1', startsAt: new Date(Date.now() + 3_600_000).toISOString() }],
    ...overrides,
  };
}

export function applied(outcome: SportsbookLedgerOutcome): SportsbookLedgerApplied {
  if (outcome.status === 'refused') {
    throw new Error(`expected the ledger to apply, it refused: ${outcome.reason}`);
  }
  return outcome;
}

export async function balanceOf(testDb: TestDb, walletId: string): Promise<string> {
  const [row] = await testDb.drizzle.db
    .select({ amount: walletBalance.amount })
    .from(walletBalance)
    .where(and(eq(walletBalance.walletId, walletId), eq(walletBalance.currency, 'USD')));
  return row?.amount ?? '0';
}

export const sportsbookWalletRows = (testDb: TestDb, walletId: string) =>
  testDb.drizzle.db
    .select({
      id: walletTransaction.id,
      type: walletTransaction.type,
      amount: walletTransaction.amount,
    })
    .from(walletTransaction)
    .where(
      and(
        eq(walletTransaction.walletId, walletId),
        like(walletTransaction.providerName, 'sportsbook:%'),
      ),
    );

export { ledgerPlayEligibility, walletBalance };
