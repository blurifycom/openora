import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  AUDIT_WRITER,
  IDENTITY_READER,
  PLAY_ELIGIBILITY_PROJECTION,
  USER_COMMANDS,
  WALLET_COMMANDS,
  WALLET_READER,
  type AdminGameReporting,
  type AdminUserDirectory,
  type ChatBlockWriter,
  type SessionCommands,
} from '@openora/core/contracts';
import {
  Container,
  DRIZZLE,
  EVENT_BUS,
  ModuleRegistryImpl,
  type CoreTokenCatalog,
} from '@openora/core/server';
import { createTestDb, seedPlayerWithUser, type TestDb } from '@openora/core/testing';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { migrate as migrateTag } from '@openora/core/pam/migrate/tag';
import { backfillPlayEligibility } from '@openora/core/pam/identity/seed';
import identityPlugin from '@openora/core/pam/plugins/identity';
import { migrate as migrateWallet } from '@openora/core/wallet/migrate';
import { wallet, walletBalance } from '@openora/core/wallet/schema';
import walletPlugin from '@openora/core/wallet/plugin';
import { makeAuditWriter, makeEventBus, makeIdentityReader, mock } from '../../../testing/mock.js';
import { PlayerService } from '../service/player.service.js';

// A player status change through the real identity USER_COMMANDS into the real ledger
// projection: what a stake sees once suspend, close or reopen commits.

let db: TestDb;
let container: Container<CoreTokenCatalog>;

const players = () =>
  new PlayerService(
    db.drizzle,
    makeEventBus(),
    mock<AdminUserDirectory>({}),
    mock<AdminGameReporting>({}),
    mock<ChatBlockWriter>({}),
    mock<SessionCommands>({ revokeAll: vi.fn(async () => ({ success: true })) }),
    container.get(USER_COMMANDS),
    container.get(WALLET_READER),
  );

async function fundedPlayer() {
  const { account, player } = await seedPlayerWithUser(db, { status: 'active' });
  const [row] = await db.drizzle.db
    .insert(wallet)
    .values({ userId: account.id, currency: 'USD' })
    .returning();
  await db.drizzle.db
    .insert(walletBalance)
    .values({ walletId: row!.id, currency: 'USD', amount: '1000' });
  await backfillPlayEligibility(db.drizzle.db, container.get(PLAY_ELIGIBILITY_PROJECTION));
  return { userId: account.id, playerId: player.id };
}

const bet = (userId: string) =>
  container.get(WALLET_COMMANDS).debit(db.drizzle.db, { userId, amount: '10', type: 'bet' });

const refused = { name: 'WalletRgRestrictedError' };
const allowed = { ok: true };

beforeAll(async () => {
  db = await createTestDb([migrateIdentity, migrateProfile, migrateTag, migrateWallet]);
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

describe('a player status change reaches the ledger with the status (real PG)', () => {
  it('refuses a suspended player and lets them back once reactivated', async () => {
    const { userId, playerId } = await fundedPlayer();

    await players().update(playerId, { status: 'suspended' }, randomUUID());
    await expect(bet(userId)).rejects.toMatchObject(refused);

    await players().update(playerId, { status: 'active' }, randomUUID());
    await expect(bet(userId)).resolves.toMatchObject(allowed);
  });

  it('refuses a player the system suspends', async () => {
    const { userId } = await fundedPlayer();

    await players().suspendBySystem(userId);

    await expect(bet(userId)).rejects.toMatchObject(refused);
  });

  it('refuses a closed player', async () => {
    const { userId, playerId } = await fundedPlayer();

    await players().remove(playerId, randomUUID());

    await expect(bet(userId)).rejects.toMatchObject(refused);
  });
});
