import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  AUDIT_WRITER,
  IDENTITY_READER,
  LEDGER_PLAY_ELIGIBILITY,
  PLAYER_STATUSES,
  PLAY_ELIGIBILITY,
  PLAY_ELIGIBILITY_PROJECTION,
  WALLET_COMMANDS,
  definePlatformConfig,
  domainEventSchemas,
  type McpTokenRevocation,
  type PlayerProvisioning,
  type PlayEligibilityPort,
  type PlayEligibilityProjectionPort,
  type PlayEligibilitySnapshot,
  type SmsAdapter,
} from '@openora/core/contracts';
import {
  Container,
  DRIZZLE,
  EVENT_BUS,
  ModuleRegistryImpl,
  type CoreTokenCatalog,
  type DrizzleDb,
} from '@openora/core/server';
import { createTestDb, seedPlayerWithUser, seedUser, type TestDb } from '@openora/core/testing';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { player } from '@openora/core/pam/schema/profile';
import { migrate as migrateWallet } from '@openora/core/wallet/migrate';
import { ledgerPlayEligibility, wallet, walletBalance } from '@openora/core/wallet/schema';
import walletPlugin from '@openora/core/wallet/plugin';
import { ledgerPlayEligibilityProjection } from '@openora/core/wallet/seed';
import { makeAuditWriter, makeEventBus, makeIdentityReader, mock } from '../../../testing/mock.js';
import { DrizzleAdminUserDirectory } from '../admin-user-directory.js';
import { migrate } from '../migrate.js';
import { user } from '../schema/index.js';
import { IdentityService } from '../service/identity.service.js';
import { LoginEnforcementService } from '../service/login-enforcement.service.js';
import {
  backfillPlayEligibility,
  PlayEligibilityPublisher,
} from '../service/play-eligibility.service.js';
import { SessionService } from '../service/session.service.js';
import { TwoFactorDeliveryService } from '../service/two-factor-delivery.service.js';

// Better Auth's sign-up stands in for a stub that commits the user row the way it does.
const authApi = vi.hoisted(() => ({ signUpEmail: vi.fn(), sendVerificationOTP: vi.fn() }));
vi.mock('@openora/core/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openora/core/server')>();
  return { ...actual, createAuth: vi.fn(() => ({ api: authApi })) };
});

let db: TestDb;
let container: Container<CoreTokenCatalog>;

type Projection = () => PlayEligibilityProjectionPort | undefined;
const ledger: Projection = () => container.get(PLAY_ELIGIBILITY_PROJECTION);

/** Identity's writers against the real wallet plugin, which owns the projection a stake reads. */
function identity(projection: Projection = ledger) {
  const events = makeEventBus();
  const sessions = new SessionService({
    drizzle: db.drizzle,
    events,
    identityReader: makeIdentityReader(),
    mcpTokens: mock<McpTokenRevocation>({ revokeAllForUser: vi.fn(async () => ({ revoked: 0 })) }),
  });
  const publisher = new PlayEligibilityPublisher(db.drizzle, events, projection);
  const enforcement = new LoginEnforcementService(sessions, publisher);
  return {
    events,
    publisher,
    enforcement,
    block: (userId: string) =>
      db.drizzle.db.transaction((tx) => enforcement.block(userId, { until: null }, tx)),
    unblock: (userId: string) => db.drizzle.db.transaction((tx) => enforcement.unblock(userId, tx)),
  };
}

const directory = () =>
  new DrizzleAdminUserDirectory(db.drizzle, makeEventBus(), identity().publisher);

const backfill = () =>
  backfillPlayEligibility(db.drizzle.db, container.get(PLAY_ELIGIBILITY_PROJECTION));

/** Delivers what the outbox carried, the way the wallet's event handler replays it. */
const deliver = (payload: unknown) =>
  container
    .get(PLAY_ELIGIBILITY_PROJECTION)
    .reconcile([domainEventSchemas['identity.play_eligibility.changed'].parse(payload)]);

const emitted = (events: ReturnType<typeof makeEventBus>) =>
  events.emitInTransaction.mock.calls
    .filter(([, topic]) => topic === 'identity.play_eligibility.changed')
    .map(([, , payload]) => payload);

async function fund(userId: string) {
  const [row] = await db.drizzle.db.insert(wallet).values({ userId, currency: 'USD' }).returning();
  await db.drizzle.db
    .insert(walletBalance)
    .values({ walletId: row!.id, currency: 'USD', amount: '1000' });
}

async function fundedPlayer() {
  const { account, player } = await seedPlayerWithUser(db, { status: 'active' });
  await fund(account.id);
  await backfill();
  return { userId: account.id, playerId: player.id };
}

const bet = (userId: string) =>
  container.get(WALLET_COMMANDS).debit(db.drizzle.db, { userId, amount: '10', type: 'bet' });

const refused = { name: 'WalletRgRestrictedError' };
const allowed = { ok: true };

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
    const { userId } = await fundedPlayer();
    await expect(bet(userId)).resolves.toMatchObject(allowed);

    await identity().block(userId);

    await expect(bet(userId)).rejects.toMatchObject(refused);
  });

  it('leaves the ledger as it was when the block rolls back with its caller', async () => {
    const { userId } = await fundedPlayer();
    const { enforcement } = identity();

    await expect(
      db.drizzle.db.transaction(async (tx) => {
        await enforcement.block(userId, { until: null }, tx);
        throw new Error('the RG write failed');
      }),
    ).rejects.toThrow('the RG write failed');

    const [account] = await db.drizzle.db.select().from(user).where(eq(user.id, userId));
    expect(account).toMatchObject({ rgBlocked: false, playEligibilityVersion: 0 });
    await expect(bet(userId)).resolves.toMatchObject(allowed);
  });

  it('fails the block when the ledger write throws', async () => {
    const { userId } = await fundedPlayer();
    const { block, events } = identity(() =>
      mock<PlayEligibilityProjectionPort>({
        write: () => Promise.reject(new Error('ledger down')),
      }),
    );

    await expect(block(userId)).rejects.toThrow('ledger down');

    const [account] = await db.drizzle.db.select().from(user).where(eq(user.id, userId));
    expect(account).toMatchObject({ rgBlocked: false, playEligibilityVersion: 0 });
    expect(events.emitInTransaction).not.toHaveBeenCalled();
  });

  it('keeps the newer state when the events arrive out of order', async () => {
    const { userId } = await fundedPlayer();
    // Identity in a process without the wallet: only the outbox carries the change.
    const { block, unblock, events } = identity(() => undefined);
    await block(userId);
    await unblock(userId);
    const [blocked, lifted] = emitted(events);

    await deliver(lifted);
    await deliver(blocked);

    await expect(bet(userId)).resolves.toMatchObject(allowed);
  });

  it('ignores a lift delivered after a newer restriction', async () => {
    const { userId } = await fundedPlayer();
    const { block, unblock, events } = identity();
    await block(userId);
    await unblock(userId);
    await block(userId);
    const [, staleLift] = emitted(events);

    await expect(deliver(staleLift)).resolves.toBe(0);

    await expect(bet(userId)).rejects.toMatchObject(refused);
  });

  it('overwrites a version the ledger holds ahead of identity, so a restriction still lands', async () => {
    const { userId } = await fundedPlayer();
    const poisoned: PlayEligibilitySnapshot = {
      userId,
      rgBlocked: false,
      rgBlockedUntil: null,
      isActive: true,
      banned: false,
      banExpires: null,
      status: 'active',
      version: 1_000,
    };
    await container.get(PLAY_ELIGIBILITY_PROJECTION).reconcile([poisoned]);

    await identity().block(userId);

    await expect(bet(userId)).rejects.toMatchObject(refused);
    const [row] = await db.drizzle.db
      .select()
      .from(ledgerPlayEligibility)
      .where(eq(ledgerPlayEligibility.userId, userId));
    expect(row).toMatchObject({ rgBlocked: true, version: 1 });
  });

  it('refuses a bet from a user the ledger has no row for', async () => {
    const userId = randomUUID();
    await fund(userId);

    await expect(bet(userId)).rejects.toMatchObject(refused);
  });

  it('backfills restricted users as restricted, then rewrites only rows that fell behind', async () => {
    const excluded = await seedUser(db, { rgBlocked: true });
    const suspended = await seedPlayerWithUser(db, { status: 'suspended' });
    const inactive = await seedUser(db, { isActive: false });
    const clear = await seedUser(db);

    await backfill();

    const projection = container.get(LEDGER_PLAY_ELIGIBILITY);
    await expect(projection.checkPlay(excluded.id)).resolves.toBe('self_excluded');
    await expect(projection.checkPlay(suspended.account.id)).resolves.toBe('account_suspended');
    await expect(projection.checkPlay(inactive.id)).resolves.toBe('account_inactive');
    await expect(projection.checkPlay(clear.id)).resolves.toBeNull();
    await expect(backfill()).resolves.toBe(0);

    // A direct write that skipped the publisher: same version, different state.
    await db.drizzle.db.update(user).set({ isActive: false }).where(eq(user.id, clear.id));
    const shareNowait = (userId: string) =>
      db.drizzle.db
        .select({ userId: ledgerPlayEligibility.userId })
        .from(ledgerPlayEligibility)
        .where(eq(ledgerPlayEligibility.userId, userId))
        .for('share', { noWait: true });
    await db.drizzle.db.transaction(async (tx) => {
      const inTx = ledgerPlayEligibilityProjection(tx as unknown as DrizzleDb);
      await expect(backfillPlayEligibility(tx as unknown as DrizzleDb, inTx)).resolves.toBe(1);
      // The stale row's upsert is still uncommitted: a stake on it waits, one on any other row
      // never does.
      await expect(shareNowait(clear.id)).rejects.toMatchObject({ cause: { code: '55P03' } });
      await expect(shareNowait(excluded.id)).resolves.toHaveLength(1);
    });
    await expect(projection.checkPlay(clear.id)).resolves.toBe('account_inactive');
  });

  it('keeps the ledger status enum in step with the player status enum', async () => {
    const values = async (type: string) => {
      const { rows } = await db.drizzle.db.execute<{ value: string }>(
        sql`select unnest(enum_range(null::${sql.raw(type)}))::text as value`,
      );
      return rows.map((row) => row.value);
    };

    await expect(values('ledger_player_status')).resolves.toEqual([...PLAYER_STATUSES]);
    await expect(values('player_status')).resolves.toEqual([...PLAYER_STATUSES]);
  });
});

describe('an admin deactivation reaches the ledger (real PG)', () => {
  it('refuses a deactivated account and lets it back once reactivated', async () => {
    const { userId } = await fundedPlayer();

    await directory().update(userId, { isActive: false }, randomUUID());
    await expect(bet(userId)).rejects.toMatchObject(refused);

    await directory().update(userId, { isActive: true }, randomUUID());
    await expect(bet(userId)).resolves.toMatchObject(allowed);
  });
});

describe('a new registration reaches the ledger (real PG)', () => {
  it('writes the ledger row with the player row, with no boot backfill to heal it', async () => {
    const email = `${randomUUID()}@test.dev`;
    authApi.signUpEmail.mockImplementation(async () =>
      Response.json({ user: { id: (await seedUser(db, { email })).id } }),
    );
    authApi.sendVerificationOTP.mockResolvedValue(new Response(null));
    // The profile module's provisioning: the player row and the caller's hook in one transaction.
    const createForRegistration = vi.fn<PlayerProvisioning['createForRegistration']>(
      async (record, onCreated) =>
        db.drizzle.db.transaction(async (tx) => {
          const [row] = await tx
            .insert(player)
            .values({ userId: record.userId })
            .returning({ id: player.id });
          await onCreated?.(tx, row!.id);
          return { created: true, playerId: row!.id };
        }),
    );
    const { events, publisher } = identity();
    const registration = new IdentityService({
      drizzle: db.drizzle,
      events,
      audit: makeAuditWriter(),
      identityReader: makeIdentityReader(),
      platformConfig: definePlatformConfig({
        registration: { termsVersion: 'test-v1', requireEmailVerification: false },
      }),
      playerProvisioning: mock<PlayerProvisioning>({ createForRegistration }),
      twoFactorDelivery: new TwoFactorDeliveryService({
        drizzle: db.drizzle,
        sms: mock<SmsAdapter>({ sendOtp: vi.fn() }),
      }),
      playEligibility: publisher,
    });

    await expect(
      registration.register(
        {
          email,
          password: 'password1234',
          username: 'newplayer',
          acceptedTerms: true,
          acceptedAge: true,
        },
        {},
      ),
    ).resolves.toEqual({ status: 'check-email' });

    const [account] = await db.drizzle.db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, email));
    // A user the ledger has no row for is refused as inactive, so `null` means the row landed.
    await expect(container.get(LEDGER_PLAY_ELIGIBILITY).checkPlay(account!.id)).resolves.toBeNull();
  });
});
