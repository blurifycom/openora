import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  AUDIT_WRITER,
  IDENTITY_READER,
  LOGIN_ENFORCEMENT,
  PLAY_ELIGIBILITY_PROJECTION,
  WALLET_COMMANDS,
  type ExchangeRateReader,
} from '@openora/core/contracts';
import {
  Container,
  DRIZZLE,
  EVENT_BUS,
  ModuleRegistryImpl,
  type CoreTokenCatalog,
} from '@openora/core/server';
import {
  createTestDb,
  seedPlayerWithUser,
  waitForAdvisoryLockWaiter,
  type TestDb,
} from '@openora/core/testing';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { backfillPlayEligibility } from '@openora/core/pam/identity/seed';
import identityPlugin from '@openora/core/pam/plugins/identity';
import { migrate as migrateWallet } from '@openora/core/wallet/migrate';
import { wallet, walletBalance } from '@openora/core/wallet/schema';
import walletPlugin from '@openora/core/wallet/plugin';
import { makeAuditWriter, makeEventBus, makeIdentityReader, mock } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { rgExclusion } from '../schema/index.js';
import { RgService } from '../service/rg.service.js';

// RG exclusions through the real identity enforcement into the real ledger projection: what a
// stake sees after each activate, lift and sweep, and when two of them race for one player.

let db: TestDb;
let container: Container<CoreTokenCatalog>;

const rates = mock<ExchangeRateReader>({
  getRate: vi.fn(async () => ({ rate: '1', asOf: new Date().toISOString() })),
  convert: vi.fn(async (amount: string) => amount),
});

/** An RgService whose transaction, given `parkOn`, holds at that event until released. */
function rg(parkOn?: string) {
  const events = makeEventBus();
  let reached!: () => void;
  let release!: () => void;
  const parked = new Promise<void>((resolve) => (reached = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  events.emitInTransaction.mockImplementation(async (_tx: unknown, topic: string) => {
    if (topic === parkOn) {
      reached();
      await gate;
    }
  });
  const svc = new RgService({
    drizzle: db.drizzle,
    events,
    loginEnforcement: container.get(LOGIN_ENFORCEMENT),
    identityReader: makeIdentityReader(),
    rates,
  });
  return { svc, parked, release };
}

async function fundedPlayer() {
  const { account } = await seedPlayerWithUser(db, { status: 'active' });
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

const bet = (userId: string) =>
  container.get(WALLET_COMMANDS).debit(db.drizzle.db, { userId, amount: '10', type: 'bet' });

const refused = { name: 'WalletRgRestrictedError' };
const allowed = { ok: true };

async function seedExclusion(
  userId: string,
  values: Pick<typeof rgExclusion.$inferInsert, 'kind' | 'expiresAt'>,
) {
  await db.drizzle.db.insert(rgExclusion).values({
    userId,
    status: 'active',
    reason: 'test',
    isPermanent: false,
    startsAt: new Date(Date.now() - 3_600_000),
    createdBy: userId,
    ...values,
  });
}

const activeSelfExclusions = (userId: string) =>
  db.drizzle.db
    .select()
    .from(rgExclusion)
    .where(
      and(
        eq(rgExclusion.userId, userId),
        eq(rgExclusion.kind, 'self_exclusion'),
        eq(rgExclusion.status, 'active'),
      ),
    );

const selfExclude = (svc: RgService, userId: string) =>
  svc.activateSelfExclusion(
    userId,
    { userId, isPermanent: true, reason: 'gambling concern', confirm: true },
    userId,
    'player',
  );

const coolOff = (svc: RgService, userId: string) =>
  svc.activateCoolingOff(
    userId,
    { userId, durationHours: 24, reason: 'a break' },
    userId,
    'player',
  );

const liftCoolingOff = (svc: RgService, userId: string) =>
  svc.liftCoolingOff(userId, { userId, reason: 'support request' }, randomUUID());

beforeAll(async () => {
  db = await createTestDb([migrateIdentity, migrateProfile, migrateWallet, migrate]);
  container = new Container<CoreTokenCatalog>();
  container.register(DRIZZLE, () => db.drizzle);
  container.register(EVENT_BUS, () => makeEventBus());
  container.register(AUDIT_WRITER, () => makeAuditWriter());
  container.register(IDENTITY_READER, () => makeIdentityReader());
  vi.stubEnv('WITHDRAWAL_PIN_HMAC_SECRET', 'x'.repeat(32));
  identityPlugin.register(new ModuleRegistryImpl<CoreTokenCatalog>(container));
  walletPlugin.register(new ModuleRegistryImpl<CoreTokenCatalog>(container));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await db.drop();
});

describe('RG exclusions reach the ledger with the RG record (real PG)', () => {
  it('refuses a stake as soon as a self-exclusion commits', async () => {
    const userId = await fundedPlayer();
    await expect(bet(userId)).resolves.toMatchObject(allowed);

    await selfExclude(rg().svc, userId);

    await expect(bet(userId)).rejects.toMatchObject(refused);
  });

  it('lets a player stake again once an elapsed self-exclusion is lifted', async () => {
    const userId = await fundedPlayer();
    const { svc } = rg();
    await svc.activateSelfExclusion(
      userId,
      { userId, isPermanent: false, durationMonths: 6, reason: 'a break', confirm: true },
      userId,
      'player',
    );
    await expect(bet(userId)).rejects.toMatchObject(refused);
    await db.drizzle.db
      .update(rgExclusion)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(rgExclusion.userId, userId));

    await svc.liftSelfExclusion(
      userId,
      { userId, reason: 'period over', confirm: true },
      randomUUID(),
    );

    await expect(bet(userId)).resolves.toMatchObject(allowed);
  });

  it('lets a player stake again once a cooling-off is lifted', async () => {
    const userId = await fundedPlayer();
    await coolOff(rg().svc, userId);
    await expect(bet(userId)).rejects.toMatchObject(refused);

    await liftCoolingOff(rg().svc, userId);

    await expect(bet(userId)).resolves.toMatchObject(allowed);
  });

  it('lets a player stake again once the sweep expires their cooling-off', async () => {
    const userId = await fundedPlayer();
    await coolOff(rg().svc, userId);
    // Lapsed in the RG record, while the ledger still holds the block it was given.
    await db.drizzle.db
      .update(rgExclusion)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(rgExclusion.userId, userId));
    await expect(bet(userId)).rejects.toMatchObject(refused);

    await rg().svc.expireLapsedCoolingOffs();

    await expect(bet(userId)).resolves.toMatchObject(allowed);
  });
});

describe('RG changes racing for one player (real PG)', () => {
  it('keeps a self-exclusion that commits while the expiry sweep runs', async () => {
    const userId = await fundedPlayer();
    await seedExclusion(userId, { kind: 'cooling_off', expiresAt: new Date(Date.now() - 60_000) });
    const player = rg('rg.self_exclusion.activated');
    const exclusion = selfExclude(player.svc, userId);
    await player.parked;

    const sweep = rg().svc.expireLapsedCoolingOffs();
    await waitForAdvisoryLockWaiter(db);
    player.release();
    await Promise.all([exclusion, sweep]);

    expect(await activeSelfExclusions(userId)).toHaveLength(1);
    await expect(bet(userId)).rejects.toMatchObject(refused);
  });

  it('keeps a self-exclusion that commits while an admin lifts a cooling-off', async () => {
    const userId = await fundedPlayer();
    await seedExclusion(userId, {
      kind: 'cooling_off',
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const player = rg('rg.self_exclusion.activated');
    const exclusion = selfExclude(player.svc, userId);
    await player.parked;

    const lift = liftCoolingOff(rg().svc, userId);
    await waitForAdvisoryLockWaiter(db);
    player.release();
    await Promise.all([exclusion, lift]);

    expect(await activeSelfExclusions(userId)).toHaveLength(1);
    await expect(bet(userId)).rejects.toMatchObject(refused);
  });
});
