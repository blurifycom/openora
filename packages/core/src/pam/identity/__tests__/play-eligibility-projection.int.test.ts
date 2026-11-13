import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  AUDIT_WRITER,
  IDENTITY_READER,
  LEDGER_API_V1,
  LEDGER_PLAY_ELIGIBILITY,
  PLAY_ELIGIBILITY,
  WALLET_COMMANDS,
  domainEventSchemas,
  type LedgerApiV1,
  type LedgerV1SetPlayEligibilityArgs,
  type McpTokenRevocation,
  type PlayEligibilityPort,
} from '@openora/core/contracts';
import {
  Container,
  DRIZZLE,
  EVENT_BUS,
  ModuleRegistryImpl,
  type CoreTokenCatalog,
} from '@openora/core/server';
import { createTestDb, seedPlayerWithUser, seedUser, type TestDb } from '@openora/core/testing';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { migrate as migrateWallet } from '@openora/core/wallet/migrate';
import { wallet, walletBalance } from '@openora/core/wallet/schema';
import { backfillLedgerPlayEligibility } from '@openora/core/wallet/seed';
import walletPlugin from '@openora/core/wallet/plugin';
import { makeAuditWriter, makeEventBus, makeIdentityReader, mock } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { user } from '../schema/index.js';
import { LoginEnforcementService } from '../service/login-enforcement.service.js';
import { PlayEligibilityPublisher } from '../service/play-eligibility.service.js';
import { SessionService } from '../service/session.service.js';

let db: TestDb;
let container: Container<CoreTokenCatalog>;

/** Identity's writers against the real wallet plugin, which owns the projection a stake reads. */
function enforcement(ledger: () => LedgerApiV1 | undefined = () => container.get(LEDGER_API_V1)) {
  const events = makeEventBus();
  const sessions = new SessionService({
    drizzle: db.drizzle,
    events,
    identityReader: makeIdentityReader(),
    mcpTokens: mock<McpTokenRevocation>({ revokeAllForUser: vi.fn(async () => ({ revoked: 0 })) }),
  });
  const publisher = new PlayEligibilityPublisher(db.drizzle, events, ledger);
  return { svc: new LoginEnforcementService(db.drizzle, sessions, publisher), events };
}

/** Only the push made before the writer commits: what a stake sees before any event lands. */
const restrictOnly = (): LedgerApiV1 => {
  const real = container.get(LEDGER_API_V1);
  return mock<LedgerApiV1>({
    setPlayEligibility: (args: LedgerV1SetPlayEligibilityArgs) =>
      args.mode === 'restrict' ? real.setPlayEligibility(args) : Promise.resolve(),
  });
};

/** Delivers what the outbox carried, the way the wallet's event handler applies it. */
const deliver = (payload: unknown) =>
  container.get(LEDGER_API_V1).setPlayEligibility({
    ...domainEventSchemas['identity.play_eligibility.changed'].parse(payload),
    mode: 'apply',
  });

const emitted = (events: ReturnType<typeof makeEventBus>) =>
  events.emitInTransaction.mock.calls.map(([, , payload]) => payload);

async function fundedPlayer() {
  const account = await seedUser(db);
  const [row] = await db.drizzle.db
    .insert(wallet)
    .values({ userId: account.id, currency: 'USD' })
    .returning();
  await db.drizzle.db
    .insert(walletBalance)
    .values({ walletId: row!.id, currency: 'USD', amount: '100' });
  await backfillLedgerPlayEligibility(db.drizzle.db);
  return account.id;
}

const bet = (userId: string) =>
  container.get(WALLET_COMMANDS).debit(db.drizzle.db, { userId, amount: '10', type: 'bet' });

const refused = { name: 'WalletRgRestrictedError' };

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile, migrateWallet]);
  container = new Container<CoreTokenCatalog>();
  container.register(DRIZZLE, () => db.drizzle);
  container.register(EVENT_BUS, () => makeEventBus());
  container.register(AUDIT_WRITER, () => makeAuditWriter());
  container.register(IDENTITY_READER, () => makeIdentityReader());
  container.register(PLAY_ELIGIBILITY, () => mock<PlayEligibilityPort>({}));
  walletPlugin.register(new ModuleRegistryImpl<CoreTokenCatalog>(container));
});

afterAll(async () => {
  await db.drop();
});

describe('the ledger play eligibility projection (real PG)', () => {
  it('refuses a bet right after a self-exclusion, before the outbox event is delivered', async () => {
    const userId = await fundedPlayer();
    await expect(bet(userId)).resolves.toMatchObject({ ok: true });
    const { svc } = enforcement(restrictOnly);

    await svc.block(userId, { until: null });

    await expect(bet(userId)).rejects.toMatchObject(refused);
  });

  it('keeps the newer state when the events arrive out of order', async () => {
    const userId = await fundedPlayer();
    const { svc, events } = enforcement(() => undefined);
    await svc.block(userId, { until: null });
    await svc.unblock(userId);
    const [blocked, lifted] = emitted(events);

    await deliver(lifted);
    await deliver(blocked);

    await expect(bet(userId)).resolves.toMatchObject({ ok: true });
  });

  it('fails the self-exclusion when the ledger write throws', async () => {
    const userId = await fundedPlayer();
    const { svc, events } = enforcement(() =>
      mock<LedgerApiV1>({ setPlayEligibility: () => Promise.reject(new Error('ledger down')) }),
    );

    await expect(svc.block(userId, { until: null })).rejects.toThrow('ledger down');

    const [row] = await db.drizzle.db.select().from(user).where(eq(user.id, userId));
    expect(row).toMatchObject({ rgBlocked: false, playEligibilityVersion: 0 });
    expect(events.emitInTransaction).not.toHaveBeenCalled();
  });

  it('lifts the projection on a lift, and ignores a lift older than a newer restriction', async () => {
    const userId = await fundedPlayer();
    const { svc, events } = enforcement();
    await svc.block(userId, { until: null });
    await svc.unblock(userId);
    await expect(bet(userId)).resolves.toMatchObject({ ok: true });

    await svc.block(userId, { until: null });
    const [, staleLift] = emitted(events);
    await deliver(staleLift);

    await expect(bet(userId)).rejects.toMatchObject(refused);
  });

  it('refuses a bet from a user the ledger has no row for', async () => {
    const userId = randomUUID();
    const [row] = await db.drizzle.db
      .insert(wallet)
      .values({ userId, currency: 'USD' })
      .returning();
    await db.drizzle.db
      .insert(walletBalance)
      .values({ walletId: row!.id, currency: 'USD', amount: '100' });

    await expect(bet(userId)).rejects.toMatchObject(refused);
  });

  it('backfills existing restricted users as restricted', async () => {
    const excluded = await seedUser(db, { rgBlocked: true });
    const suspended = await seedPlayerWithUser(db, { status: 'suspended' });
    const inactive = await seedUser(db, { isActive: false });
    const clear = await seedUser(db);

    await backfillLedgerPlayEligibility(db.drizzle.db);

    const projection = container.get(LEDGER_PLAY_ELIGIBILITY);
    await expect(projection.checkPlay(excluded.id)).resolves.toBe('self_excluded');
    await expect(projection.checkPlay(suspended.account.id)).resolves.toBe('account_suspended');
    await expect(projection.checkPlay(inactive.id)).resolves.toBe('account_inactive');
    await expect(projection.checkPlay(clear.id)).resolves.toBeNull();
  });
});
