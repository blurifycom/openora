import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, type TestDb, seedUser } from '@openora/core/testing';
import { user } from '@openora/core/pam/schema/identity';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import type { WalletReader, ExchangeRateReader } from '@openora/core/contracts';
import { player } from '../schema/index.js';
import { migrate } from '../migrate.js';
import { ProfileService } from '../service/profile.service.js';
import { mock, makeAuditWriter } from '../../../testing/mock.js';

let db: TestDb;

const DEFAULT_SUPPORTED = ['USD', 'EUR', 'BTC'];

function makeService(
  overrides: {
    walletReader?: WalletReader;
    exchangeRateReader?: ExchangeRateReader;
    supported?: string[];
  } = {},
): ProfileService {
  return new ProfileService(
    db.drizzle,
    overrides.walletReader ??
      mock<WalletReader>({ getBalances: async () => ({ activeCurrency: 'USD', balances: [] }) }),
    overrides.exchangeRateReader ?? mock<ExchangeRateReader>({}),
    makeAuditWriter(),
    overrides.supported ?? DEFAULT_SUPPORTED,
  );
}

async function seedPlayer(userId: string, overrides: Partial<typeof player.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(player)
    .values({ userId, ...overrides })
    .returning();
  return row!;
}

async function playersFor(userId: string) {
  return db.drizzle.db.select().from(player).where(eq(player.userId, userId));
}

beforeAll(async () => {
  db = await createTestDb([migrateIdentity, migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${player}, ${user} RESTART IDENTITY CASCADE`);
});

describe('ProfileService.getMyProfile (real PG)', () => {
  it('materializes a player row from the users username on first access', async () => {
    const svc = makeService();
    const account = await seedUser(db, { name: 'Jordan', username: 'jordan_player' });

    const profile = await svc.getMyProfile(account.id);

    expect(profile).toMatchObject({
      userId: account.id,
      username: 'jordan_player',
      email: account.email,
    });
    expect(await playersFor(account.id)).toHaveLength(1);
  });

  it('returns the existing row without inserting a second one on a later call', async () => {
    const svc = makeService();
    const account = await seedUser(db);
    await seedPlayer(account.id, { country: 'US' });

    const profile = await svc.getMyProfile(account.id);

    expect(profile).toMatchObject({ username: account.username, country: 'US' });
    expect(await playersFor(account.id)).toHaveLength(1);
  });

  it('creates exactly one player row when two first accesses race on the same user', async () => {
    const svc = makeService();
    const account = await seedUser(db);

    const [a, b] = await Promise.all([svc.getMyProfile(account.id), svc.getMyProfile(account.id)]);

    expect(a.id).toBe(b.id);
    expect(await playersFor(account.id)).toHaveLength(1);
  });
});

describe('ProfileService.updateMyProfile (real PG)', () => {
  it('persists profile fields and returns the mapped player with email', async () => {
    const svc = makeService();
    const account = await seedUser(db, { name: 'Player One' });
    await seedPlayer(account.id, { country: null });

    const result = await svc.updateMyProfile(account.id, { country: 'US' });

    expect(result).toMatchObject({ country: 'US', email: account.email });
    const [row] = await playersFor(account.id);
    expect(row?.country).toBe('US');
  });

  it('materializes the profile first when update is the first call for a user', async () => {
    const svc = makeService();
    const account = await seedUser(db, { name: 'Fresh', username: 'fresh_player' });

    const result = await svc.updateMyProfile(account.id, { currency: 'EUR' });

    expect(result).toMatchObject({ username: 'fresh_player', currency: 'EUR' });
    expect(await playersFor(account.id)).toHaveLength(1);
  });

  it('persists the registration profile fields the signup step collects', async () => {
    const svc = makeService();
    const account = await seedUser(db);
    await seedPlayer(account.id);

    const result = await svc.updateMyProfile(account.id, {
      firstName: 'Ada',
      lastName: 'Lovelace',
      dateOfBirth: '1990-05-17',
      phone: '+441632960001',
      country: 'GB',
    });

    expect(result).toMatchObject({
      firstName: 'Ada',
      lastName: 'Lovelace',
      dateOfBirth: '1990-05-17',
      phone: '+441632960001',
      country: 'GB',
    });
    const [row] = await playersFor(account.id);
    expect(row).toMatchObject({
      firstName: 'Ada',
      lastName: 'Lovelace',
      // A `date` column in string mode must come back as the calendar day it went in as,
      // with no timezone shift.
      dateOfBirth: '1990-05-17',
      phone: '+441632960001',
    });
  });

  it('leaves omitted fields alone and clears the ones explicitly set to null', async () => {
    const svc = makeService();
    const account = await seedUser(db);
    await seedPlayer(account.id, {
      firstName: 'Ada',
      lastName: 'Lovelace',
      dateOfBirth: '1990-05-17',
      phone: '+441632960001',
    });

    const result = await svc.updateMyProfile(account.id, { firstName: 'Augusta', phone: null });

    expect(result).toMatchObject({
      firstName: 'Augusta',
      lastName: 'Lovelace',
      dateOfBirth: '1990-05-17',
      phone: null,
    });
  });

  it('leaves other players untouched', async () => {
    const svc = makeService();
    const account = await seedUser(db);
    const other = await seedUser(db);
    await seedPlayer(account.id, { country: 'US' });
    await seedPlayer(other.id, { country: 'CA' });

    await svc.updateMyProfile(account.id, { country: 'FR' });

    const [otherRow] = await playersFor(other.id);
    expect(otherRow?.country).toBe('CA');
  });
});

describe('ProfileService.getMyDisplayCurrency (real PG)', () => {
  it('returns the explicitly chosen currency when player.displayCurrency is set', async () => {
    const account = await seedUser(db);
    await seedPlayer(account.id, { displayCurrency: 'EUR' });
    const svc = makeService();

    const result = await svc.getMyDisplayCurrency(account.id);

    expect(result).toEqual({ currency: 'EUR', supported: DEFAULT_SUPPORTED });
  });

  it('falls back to the currency held with the most value when nothing was chosen', async () => {
    const account = await seedUser(db);
    await seedPlayer(account.id, { displayCurrency: null });
    const svc = makeService({
      walletReader: mock<WalletReader>({
        getBalances: async () => ({
          activeCurrency: 'USD',
          balances: [
            { currency: 'USD', balance: '10' },
            { currency: 'BTC', balance: '1' },
          ],
        }),
      }),
      exchangeRateReader: mock<ExchangeRateReader>({
        // 1 BTC "converts" to 50000 USD-equivalent units - worth more than the 10 USD balance.
        convert: async (amount: string, from: string) => (from === 'BTC' ? '50000' : amount),
      }),
    });

    const result = await svc.getMyDisplayCurrency(account.id);

    expect(result.currency).toBe('BTC');
  });

  it('skips a balance whose rate is unavailable rather than failing', async () => {
    const account = await seedUser(db);
    await seedPlayer(account.id, { displayCurrency: null });
    const svc = makeService({
      walletReader: mock<WalletReader>({
        getBalances: async () => ({
          activeCurrency: 'USD',
          balances: [
            { currency: 'USD', balance: '10' },
            { currency: 'XOF', balance: '999999' },
          ],
        }),
      }),
      exchangeRateReader: mock<ExchangeRateReader>({
        convert: async (amount: string, from: string) => (from === 'XOF' ? null : amount),
      }),
    });

    const result = await svc.getMyDisplayCurrency(account.id);

    expect(result.currency).toBe('USD');
  });

  it('falls back to the wallet active currency when no balance is held', async () => {
    const account = await seedUser(db);
    await seedPlayer(account.id, { displayCurrency: null });
    const svc = makeService({
      walletReader: mock<WalletReader>({
        getBalances: async () => ({ activeCurrency: 'GBP', balances: [] }),
      }),
    });

    const result = await svc.getMyDisplayCurrency(account.id);

    expect(result.currency).toBe('GBP');
  });
});

describe('ProfileService.setMyDisplayCurrency (real PG)', () => {
  it('persists the pick, records an audit entry, and returns it', async () => {
    const account = await seedUser(db);
    await seedPlayer(account.id, { displayCurrency: null });
    const audit = makeAuditWriter();
    const svc = new ProfileService(
      db.drizzle,
      mock<WalletReader>({}),
      mock<ExchangeRateReader>({}),
      audit,
      DEFAULT_SUPPORTED,
    );

    const result = await svc.setMyDisplayCurrency(account.id, { currency: 'EUR' });

    expect(result).toEqual({ currency: 'EUR', supported: DEFAULT_SUPPORTED });
    const [row] = await playersFor(account.id);
    expect(row?.displayCurrency).toBe('EUR');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: account.id,
        actorType: 'player',
        action: 'player.display_currency.set',
      }),
    );
  });

  it('rejects a currency outside the operator-supported list', async () => {
    const account = await seedUser(db);
    await seedPlayer(account.id, { displayCurrency: null });
    const svc = makeService({ supported: ['USD', 'EUR'] });

    await expect(svc.setMyDisplayCurrency(account.id, { currency: 'BTC' })).rejects.toThrow(
      /not supported/,
    );
    const [row] = await playersFor(account.id);
    expect(row?.displayCurrency).toBeNull();
  });
});
