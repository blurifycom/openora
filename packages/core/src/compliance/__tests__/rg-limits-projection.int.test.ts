import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import {
  AUDIT_WRITER,
  EXCHANGE_RATE_READER,
  IDENTITY_READER,
  LOGIN_ENFORCEMENT,
  PLAY_ELIGIBILITY_PROJECTION,
  RG_LIMITS,
  RG_LIMIT_LEDGER,
  WALLET_COMMANDS,
  defaultResponsibleGamingConfig,
  type ExchangeRateReader,
  type RgLimitLedgerPort,
  type RgLimitsSnapshot,
} from '@openora/core/contracts';
import {
  Container,
  DRIZZLE,
  EVENT_BUS,
  ModuleRegistryImpl,
  type CoreTokenCatalog,
  type DrizzleTx,
} from '@openora/core/server';
import {
  createTestDb,
  seedPlayerWithUser,
  waitForRowLockWaiter,
  type TestDb,
} from '@openora/core/testing';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { backfillPlayEligibility } from '@openora/core/pam/identity/seed';
import { player } from '@openora/core/pam/schema/profile';
import identityPlugin from '@openora/core/pam/plugins/identity';
import { migrate as migrateWallet } from '@openora/core/wallet/migrate';
import {
  ledgerUserLimit,
  ledgerUserLimitVersion,
  wallet,
  walletBalance,
} from '@openora/core/wallet/schema';
import walletPlugin from '@openora/core/wallet/plugin';
import { makeAuditWriter, makeEventBus, makeIdentityReader, mock } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { rgLimitVersion, userLimit } from '../schema/index.js';
import { RgService } from '../service/rg.service.js';
import { RgMonitoringService } from '../service/rg-monitoring.service.js';
import { RgSelfServiceService } from '../service/rg-self-service.service.js';
import { backfillRgLimits } from '../service/rg-limits-publisher.service.js';

// Limits through the real compliance writers into the wallet's own projection, and the stakes the
// real wallet gate then lets through (ADR-0055). The event bus is a mock: nothing here is ever
// delivered, so every refusal is the in-transaction write's, not the outbox's.

let db: TestDb;
let container: Container<CoreTokenCatalog>;

const rates = mock<ExchangeRateReader>({
  getRate: vi.fn(async (from: string, to: string) =>
    from === to ? { rate: '1', asOf: new Date().toISOString() } : null,
  ),
  convert: vi.fn(async (amount: string, from: string, to: string) => (from === to ? amount : null)),
});

const HOUR = 60 * 60 * 1000;

function services(ledger: Pick<RgLimitLedgerPort, 'write'> = container.get(RG_LIMIT_LEDGER)) {
  const events = makeEventBus();
  const rg = new RgService({
    drizzle: db.drizzle,
    events,
    loginEnforcement: container.get(LOGIN_ENFORCEMENT),
    identityReader: makeIdentityReader(),
    rates,
    limitsLedger: ledger,
  });
  const selfService = new RgSelfServiceService({
    drizzle: db.drizzle,
    events,
    rg,
    monitoring: new RgMonitoringService({
      drizzle: db.drizzle,
      ledger: container.get(RG_LIMIT_LEDGER),
    }),
    identityReader: makeIdentityReader(),
    config: defaultResponsibleGamingConfig,
    rates,
  });
  return { rg, selfService, events };
}

const wagerLimit = (amount: string) =>
  ({ type: 'wager', amount, minutes: null, currency: 'USD', period: 'daily' }) as const;

async function fundedPlayer(currency = 'USD') {
  const { account } = await seedPlayerWithUser(db, { status: 'active', currency });
  const [row] = await db.drizzle.db
    .insert(wallet)
    .values({ userId: account.id, currency: 'USD' })
    .returning();
  await db.drizzle.db
    .insert(walletBalance)
    .values({ walletId: row!.id, currency: 'USD', amount: '1000' });
  await backfillPlayEligibility(db.drizzle.db, container.get(PLAY_ELIGIBILITY_PROJECTION));
  return account.id;
}

const bet = (userId: string, amount = '10') =>
  container.get(WALLET_COMMANDS).debit(db.drizzle.db, { userId, amount, type: 'bet' });

const refused = { name: 'RgLimitExceededError', data: { reason: 'wager_limit_exceeded' } };

async function projected(userId: string) {
  const [version] = await db.drizzle.db
    .select({ version: ledgerUserLimitVersion.version })
    .from(ledgerUserLimitVersion)
    .where(eq(ledgerUserLimitVersion.userId, userId));
  const rows = await db.drizzle.db
    .select({ amount: ledgerUserLimit.amount, currency: ledgerUserLimit.currency })
    .from(ledgerUserLimit)
    .where(eq(ledgerUserLimit.userId, userId));
  return { version: version?.version, amounts: rows.map((row) => Number(row.amount)), rows };
}

function publishedSnapshots(events: ReturnType<typeof makeEventBus>): RgLimitsSnapshot[] {
  return events.emitInTransaction.mock.calls
    .filter(([, topic]) => topic === 'compliance.rg_limits.changed')
    .map(([, , payload]) => payload as RgLimitsSnapshot);
}

beforeAll(async () => {
  db = await createTestDb([migrateIdentity, migrateProfile, migrateWallet, migrate]);
  container = new Container<CoreTokenCatalog>();
  container.register(DRIZZLE, () => db.drizzle);
  container.register(EVENT_BUS, () => makeEventBus());
  container.register(AUDIT_WRITER, () => makeAuditWriter());
  container.register(IDENTITY_READER, () => makeIdentityReader());
  container.register(EXCHANGE_RATE_READER, () => rates);
  vi.stubEnv('WITHDRAWAL_PIN_HMAC_SECRET', 'x'.repeat(32));
  identityPlugin.register(new ModuleRegistryImpl<CoreTokenCatalog>(container));
  walletPlugin.register(new ModuleRegistryImpl<CoreTokenCatalog>(container));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${userLimit}, ${rgLimitVersion}, ${ledgerUserLimit}, ${ledgerUserLimitVersion}`,
  );
});

describe('a limit change reaches the ledger in its own transaction (real PG)', () => {
  it('refuses a stake over a lowered limit with no event delivered', async () => {
    const userId = await fundedPlayer();
    const { selfService, events } = services();
    await selfService.upsertLimit(userId, wagerLimit('100'));
    await expect(bet(userId)).resolves.toMatchObject({ ok: true });

    await selfService.upsertLimit(userId, wagerLimit('15'));

    await expect(bet(userId)).rejects.toMatchObject(refused);
    expect(publishedSnapshots(events).map((snapshot) => snapshot.version)).toEqual([1, 2]);
  });

  it('keeps an increase out of the ledger until its cool-down ends and the player confirms', async () => {
    const userId = await fundedPlayer();
    const { selfService } = services();
    await selfService.upsertLimit(userId, wagerLimit('20'));
    await expect(bet(userId)).resolves.toMatchObject({ ok: true });

    await selfService.upsertLimit(userId, wagerLimit('1000'));
    await expect(bet(userId, '15')).rejects.toMatchObject(refused);
    expect((await projected(userId)).amounts).toEqual([20]);

    const [row] = await db.drizzle.db.select().from(userLimit).where(eq(userLimit.userId, userId));
    await db.drizzle.db
      .update(userLimit)
      .set({
        pendingEffectiveAt: new Date(Date.now() - HOUR),
        pendingExpiresAt: new Date(Date.now() + HOUR),
      })
      .where(eq(userLimit.id, row!.id));
    await selfService.confirmPendingChange(row!.id, userId);

    expect((await projected(userId)).amounts).toEqual([1000]);
    await expect(bet(userId, '15')).resolves.toMatchObject({ ok: true });
  });

  it('lets exactly one of two concurrent stakes through at the edge of the limit', async () => {
    const userId = await fundedPlayer();
    await services().selfService.upsertLimit(userId, wagerLimit('15'));

    const results = await Promise.allSettled([bet(userId), bet(userId)]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const [rejection] = results.filter((result) => result.status === 'rejected');
    expect(rejection?.reason).toMatchObject(refused);
  });

  it('never deadlocks a limit change against a stake on the same player', async () => {
    const userId = await fundedPlayer();
    const { selfService } = services();
    await selfService.upsertLimit(userId, wagerLimit('1000'));

    for (let round = 0; round < 15; round += 1) {
      const results = await Promise.allSettled([
        bet(userId, '1'),
        selfService.upsertLimit(userId, wagerLimit(String(990 - round))),
        bet(userId, '1'),
      ]);
      for (const result of results) {
        if (result.status === 'rejected') {
          throw result.reason;
        }
      }
    }
    expect((await projected(userId)).amounts).toEqual([976]);
  });

  it('leaves the projection as it was when the limit change rolls back', async () => {
    const userId = await fundedPlayer();
    await services().selfService.upsertLimit(userId, wagerLimit('100'));
    const before = await projected(userId);
    const { selfService, events } = services();
    events.emitInTransaction.mockImplementation(async (_tx: unknown, topic: string) => {
      if (topic === 'compliance.rg_limits.changed') {
        throw new Error('outbox down');
      }
    });

    await expect(selfService.upsertLimit(userId, wagerLimit('15'))).rejects.toThrow('outbox down');

    expect(await projected(userId)).toEqual(before);
    await expect(bet(userId)).resolves.toMatchObject({ ok: true });
  });

  it('fails the limit change when the projection write fails', async () => {
    const userId = await fundedPlayer();
    const { selfService } = services({
      write: async () => {
        throw new Error('projection down');
      },
    });

    await expect(selfService.upsertLimit(userId, wagerLimit('15'))).rejects.toThrow(
      'projection down',
    );

    expect(
      await db.drizzle.db.select().from(userLimit).where(eq(userLimit.userId, userId)),
    ).toHaveLength(0);
  });

  it('never loosens the projection on a late or replayed event', async () => {
    const userId = await fundedPlayer();
    const { selfService, events } = services();
    await selfService.upsertLimit(userId, wagerLimit('100'));
    await selfService.upsertLimit(userId, wagerLimit('15'));
    const [first, second] = publishedSnapshots(events);

    const ledger = container.get(RG_LIMIT_LEDGER);
    await expect(ledger.reconcile([first!])).resolves.toBe(0);
    await expect(ledger.reconcile([second!, first!])).resolves.toBe(0);

    expect(await projected(userId)).toMatchObject({ version: 2, amounts: [15] });
    await expect(bet(userId, '20')).rejects.toMatchObject(refused);
  });
});

describe('the projection outside a limit write (real PG)', () => {
  it('refuses on a limit with no rate for the attempted currency, and on an unresolved one', async () => {
    const userId = await fundedPlayer();
    await services().selfService.upsertLimit(userId, {
      ...wagerLimit('100'),
      type: 'deposit',
    });
    const gate = container.get(RG_LIMITS);

    await expect(gate.checkDeposit(db.drizzle.db, userId, '1', 'BTC')).resolves.toMatchObject({
      allowed: false,
      limitType: 'deposit',
      currency: 'USD',
    });

    const orphan = crypto.randomUUID();
    await db.drizzle.db.insert(userLimit).values({
      userId: orphan,
      type: 'deposit',
      amount: '100',
      currency: null,
      period: 'daily',
    });
    await backfillRgLimits(db.drizzle.db, container.get(RG_LIMIT_LEDGER));
    await expect(gate.checkDeposit(db.drizzle.db, orphan, '1', 'USD')).resolves.toMatchObject({
      allowed: false,
      currency: null,
    });
  });

  it('enforces a limit from before the projection once the migration ran, before any backfill', async () => {
    const userId = await fundedPlayer();
    await db.drizzle.db.insert(userLimit).values({ userId, ...wagerLimit('15') });

    await db.drizzle.db.execute(
      sql.raw(
        readFileSync(
          new URL(
            '../../wallet/drizzle/migrations/0047_seed_ledger_user_limit.sql',
            import.meta.url,
          ),
          'utf8',
        ),
      ),
    );

    await expect(bet(userId)).resolves.toMatchObject({ ok: true });
    await expect(bet(userId)).rejects.toMatchObject(refused);
    expect(await projected(userId)).toMatchObject({ version: 0, amounts: [15] });
    await expect(backfillRgLimits(db.drizzle.db, container.get(RG_LIMIT_LEDGER))).resolves.toBe(0);
  });

  it('backfills only a stale user, and never locks one whose projection matches', async () => {
    const { selfService } = services();
    const [current, stale] = [await fundedPlayer(), await fundedPlayer()].sort();
    await selfService.upsertLimit(current!, wagerLimit('100'));
    await selfService.upsertLimit(stale!, wagerLimit('100'));
    // A writer that skipped the publisher: same version, different limits.
    await db.drizzle.db.update(userLimit).set({ amount: '40' }).where(eq(userLimit.userId, stale!));

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const holder = db.drizzle.db.transaction(async (tx) => {
      await tx
        .select()
        .from(ledgerUserLimitVersion)
        .where(eq(ledgerUserLimitVersion.userId, stale!))
        .for('update');
      await held;
    });
    const backfill = backfillRgLimits(db.drizzle.db, container.get(RG_LIMIT_LEDGER), {
      batchSize: 1,
    });
    await waitForRowLockWaiter(db);

    const probe = (userId: string) =>
      db.drizzle.db.transaction(async (tx: DrizzleTx) => {
        await tx.execute(
          sql`select 1 from ${ledgerUserLimitVersion} where user_id = ${userId} for share nowait`,
        );
        await tx.execute(
          sql`select 1 from ${ledgerUserLimit} where user_id = ${userId} for share nowait`,
        );
      });
    await expect(probe(current!)).resolves.toBeUndefined();
    await expect(probe(stale!)).rejects.toThrow();

    release();
    await holder;
    await expect(backfill).resolves.toBe(1);
    expect((await projected(stale!)).amounts).toEqual([40]);
    expect(await projected(current!)).toMatchObject({ version: 1, amounts: [100] });
  });

  it('heals, on the recent-change pass, a limit lowered by a writer that skipped the publisher', async () => {
    const { selfService } = services();
    const [recent, old] = [await fundedPlayer(), await fundedPlayer()];
    await selfService.upsertLimit(recent!, wagerLimit('100'));
    await selfService.upsertLimit(old!, wagerLimit('100'));
    await db.drizzle.db
      .update(userLimit)
      .set({ amount: '15' })
      .where(eq(userLimit.userId, recent!));
    await db.drizzle.db
      .update(userLimit)
      .set({ amount: '15', updatedAt: new Date(Date.now() - 2 * HOUR) })
      .where(eq(userLimit.userId, old!));

    await expect(
      backfillRgLimits(db.drizzle.db, container.get(RG_LIMIT_LEDGER), {
        changedSince: new Date(Date.now() - HOUR),
      }),
    ).resolves.toBe(1);

    await expect(bet(recent!, '20')).rejects.toMatchObject(refused);
    expect((await projected(old!)).amounts).toEqual([100]);
  });

  it("re-projects an unresolved limit when the player's currency changes", async () => {
    const userId = await fundedPlayer('EUR');
    const { rg } = services();
    await db.drizzle.db.insert(userLimit).values({ userId, ...wagerLimit('100'), currency: null });
    await backfillRgLimits(db.drizzle.db, container.get(RG_LIMIT_LEDGER));
    const gate = container.get(RG_LIMITS);
    await expect(gate.referenceCurrency(db.drizzle.db, userId)).resolves.toBe('EUR');

    // What the profile service does on a currency change (its own test covers that it does).
    await db.drizzle.db.transaction(async (tx) => {
      await tx.update(player).set({ currency: 'GBP' }).where(eq(player.userId, userId));
      await rg.limitsPublisher.publish(tx, userId);
    });

    await expect(gate.referenceCurrency(db.drizzle.db, userId)).resolves.toBe('GBP');
    await services().selfService.upsertLimit(userId, {
      ...wagerLimit('50'),
      type: 'deposit',
    });
    await expect(gate.referenceCurrency(db.drizzle.db, userId)).resolves.toBe('USD');
  });
});
