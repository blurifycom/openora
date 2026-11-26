import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as z from 'zod';
import { DRIZZLE } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import { player } from '@openora/core/pam/schema/profile';
import { PlayerSchema } from '@openora/core/contracts';
import { PlayerProfileCardSchema } from '@openora/core/pam/contracts/player';
import { DisplayCurrencyInfoSchema } from '@openora/core/pam/contracts/profile';
import { bootE2e, closeE2e, flushAudit, newPlayer, type E2e } from '../index.js';
import { ErrorBodySchema } from './support/identity.js';

let e2e: E2e;

beforeAll(async () => {
  e2e = await bootE2e();
}, 60_000);

afterAll(() => closeE2e(e2e));

const db = () => e2e.app.container.get(DRIZZLE).db;

const UserLanguageSchema = z.object({ user: z.object({ language: z.string() }) });

async function bodyOf(res: Response): Promise<unknown> {
  return res.json();
}

async function errorOf(res: Response) {
  return ErrorBodySchema.parse(await bodyOf(res));
}

const newMember = (prefix: string) => newPlayer(e2e.app, prefix);

async function readProfile(client: Awaited<ReturnType<typeof newMember>>['client']) {
  const res = await client.get('/profile');
  expect(res.status).toBe(200);
  return PlayerSchema.parse(await bodyOf(res));
}

async function auditRows(action: string, resourceId: string) {
  await flushAudit(e2e.app);
  return db()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.resourceId, resourceId)));
}

describe('player profile', () => {
  it('a player reads their own profile', async () => {
    const me = await newMember('pf-own');
    const other = await newMember('pf-other');

    const profile = await readProfile(me.client);
    const otherProfile = await readProfile(other.client);

    expect(profile).toEqual(
      expect.objectContaining({
        id: me.playerId,
        userId: me.userId,
        email: me.email,
        status: 'active',
      }),
    );
    expect(otherProfile.id).toBe(other.playerId);
    expect(otherProfile.email).toBe(other.email);
    expect(otherProfile.id).not.toBe(profile.id);
  });

  it('a player updates name, country and language and the profile reflects it', async () => {
    const me = await newMember('pf-update');
    const before = await readProfile(me.client);

    const res = await me.client.patch('/profile', {
      firstName: 'Ada',
      lastName: 'Lovelace',
      country: 'PL',
    });
    const language = await me.client.patch('/identity/profile', { language: 'de' });

    expect(res.status).toBe(200);
    expect(PlayerSchema.parse(await bodyOf(res))).toEqual(
      expect.objectContaining({ firstName: 'Ada', lastName: 'Lovelace', country: 'PL' }),
    );
    expect(await readProfile(me.client)).toEqual(
      expect.objectContaining({ firstName: 'Ada', lastName: 'Lovelace', country: 'PL' }),
    );
    expect(language.status).toBe(200);
    expect(UserLanguageSchema.parse(await bodyOf(language)).user.language).toBe('de');
    const [row] = await auditRows('player.profile.updated', me.playerId);
    expect(row).toEqual(
      expect.objectContaining({
        actorId: me.userId,
        actorType: 'player',
        before: { firstName: before.firstName, lastName: before.lastName, country: before.country },
        after: { firstName: 'Ada', lastName: 'Lovelace', country: 'PL' },
      }),
    );
  });

  it('a player cannot change fields reserved for operators such as status or role', async () => {
    const me = await newMember('pf-reserved');
    const before = await readProfile(me.client);

    const mixed = await me.client.patch('/profile', {
      firstName: 'Grace',
      status: 'closed',
      level: 99,
      role: 'admin',
      kycStatus: 'approved',
      totalDeposits: '1000',
    });
    const onlyReserved = await me.client.patch('/profile', { status: 'suspended', level: 50 });

    expect(mixed.status).toBe(200);
    expect(onlyReserved.status).toBe(400);
    const profile = await readProfile(me.client);
    expect(profile).toEqual(
      expect.objectContaining({
        firstName: 'Grace',
        status: before.status,
        level: before.level,
        kycStatus: before.kycStatus,
        totalDeposits: before.totalDeposits,
      }),
    );
    const adminRoute = await me.client.get('/players');
    expect(adminRoute.status).toBe(403);
  });

  it('an unsupported language is refused', async () => {
    const me = await newMember('pf-language');
    const before = UserLanguageSchema.parse(
      await bodyOf(await me.client.patch('/identity/profile', { language: 'fr' })),
    );

    const res = await me.client.patch('/identity/profile', { language: 'not a locale' });

    expect(before.user.language).toBe('fr');
    expect(res.status).toBe(400);
    const after = await me.client.patch('/identity/profile', { name: 'Same Person' });
    expect(UserLanguageSchema.parse(await bodyOf(after)).user.language).toBe('fr');
  });

  it('a phone number that does not match the country calling code is refused', async () => {
    const me = await newMember('pf-phone');
    await me.client.patch('/profile', { country: 'PL', phone: '+48512345678' });

    const mismatch = await me.client.patch('/profile', { phone: '+14155552671' });
    const countryChange = await me.client.patch('/profile', { country: 'US' });

    expect(mismatch.status).toBe(400);
    expect((await errorOf(mismatch)).data).toEqual(
      expect.objectContaining({ reason: 'phone_country_mismatch' }),
    );
    expect(countryChange.status).toBe(400);
    expect(await readProfile(me.client)).toEqual(
      expect.objectContaining({ country: 'PL', phone: '+48512345678' }),
    );
    const [stored] = await db()
      .select({ country: player.country, phone: player.phone })
      .from(player)
      .where(eq(player.id, me.playerId));
    expect(stored).toEqual({ country: 'PL', phone: '+48512345678' });
  });

  it('an anonymous caller is refused with unauthorized', async () => {
    const read = await e2e.app.app.request('/profile');
    const write = await e2e.app.app.request('/profile', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ firstName: 'Nobody' }),
    });
    const currency = await e2e.app.app.request('/profile/display-currency');

    expect([read.status, write.status, currency.status]).toEqual([401, 401, 401]);
    expect((await errorOf(read)).code).toBe('UNAUTHORIZED');
  });

  it('the profile response never includes the password hash or two factor secret', async () => {
    const me = await newMember('pf-secrets');
    await me.client.patch('/profile', { firstName: 'Quiet' });

    const profileRes = await me.client.get('/profile');
    const meRes = await me.client.get('/identity/me');
    const updateRes = await me.client.patch('/profile', { lastName: 'Person' });

    for (const res of [profileRes, meRes, updateRes]) {
      expect(res.status).toBe(200);
      const keys = Object.keys(z.record(z.string(), z.unknown()).parse(await bodyOf(res)));
      expect(keys.filter((key) => /password|secret|backupCodes|totp|hash/i.test(key))).toEqual([]);
    }
    const keys = Object.keys(PlayerSchema.shape);
    expect(Object.keys(await readProfile(me.client)).sort()).toEqual([...keys].sort());
  });
});

describe('display preferences', () => {
  it('a player sets the display currency and the setting is returned', async () => {
    const me = await newMember('pf-currency');

    const res = await me.client.put('/profile/display-currency', { currency: 'EUR' });
    const read = await me.client.get('/profile/display-currency');

    expect(res.status).toBe(200);
    expect(DisplayCurrencyInfoSchema.parse(await bodyOf(res)).currency).toBe('EUR');
    expect(DisplayCurrencyInfoSchema.parse(await bodyOf(read)).currency).toBe('EUR');
    const [stored] = await db()
      .select({ displayCurrency: player.displayCurrency })
      .from(player)
      .where(eq(player.id, me.playerId));
    expect(stored?.displayCurrency).toBe('EUR');
    const [row] = await auditRows('player.display_currency.set', me.playerId);
    expect(row).toEqual(
      expect.objectContaining({
        actorId: me.userId,
        before: { displayCurrency: null },
        after: { displayCurrency: 'EUR' },
      }),
    );
  });

  it('an unsupported display currency is refused', async () => {
    const me = await newMember('pf-badcurrency');
    await me.client.put('/profile/display-currency', { currency: 'GBP' });

    const res = await me.client.put('/profile/display-currency', { currency: 'ZZZ' });

    expect(res.status).toBe(400);
    const [stored] = await db()
      .select({ displayCurrency: player.displayCurrency })
      .from(player)
      .where(eq(player.id, me.playerId));
    expect(stored?.displayCurrency).toBe('GBP');
    expect(await auditRows('player.display_currency.set', me.playerId)).toHaveLength(1);
  });

  it('a player sets display decimal places within the allowed range and a value outside it is refused', async () => {
    const me = await newMember('pf-decimals');

    const ok = await me.client.put('/profile/display-decimal-places', { decimalPlaces: 4 });
    const tooMany = await me.client.put('/profile/display-decimal-places', { decimalPlaces: 19 });
    const negative = await me.client.put('/profile/display-decimal-places', { decimalPlaces: -1 });
    const fractional = await me.client.put('/profile/display-decimal-places', {
      decimalPlaces: 2.5,
    });

    expect(ok.status).toBe(200);
    expect(DisplayCurrencyInfoSchema.parse(await bodyOf(ok)).decimalPlaces).toBe(4);
    expect([tooMany.status, negative.status, fractional.status]).toEqual([400, 400, 400]);
    const read = await me.client.get('/profile/display-currency');
    expect(DisplayCurrencyInfoSchema.parse(await bodyOf(read)).decimalPlaces).toBe(4);
    const [stored] = await db()
      .select({ places: player.displayDecimalPlaces })
      .from(player)
      .where(eq(player.id, me.playerId));
    expect(stored?.places).toBe(4);
  });
});

describe('privacy between players', () => {
  it('one player cannot read the profile card of another player', async () => {
    const viewer = await newMember('pf-viewer');
    const owner = await newMember('pf-cardowner');

    const ownCard = await viewer.client.get(`/players/${viewer.userId}/profile-card`);
    const foreignCard = await viewer.client.get(`/players/${owner.userId}/profile-card`);
    const ownerSeesOwn = await owner.client.get(`/players/${owner.userId}/profile-card`);

    expect(ownCard.status).toBe(200);
    expect(foreignCard.status).toBe(200);
    const own = PlayerProfileCardSchema.parse(await bodyOf(ownCard));
    expect(own.joinedAt).not.toBeNull();
    expect(own.currency).not.toBeNull();
    const foreignText = await foreignCard.text();
    const foreign = PlayerProfileCardSchema.parse(JSON.parse(foreignText));
    expect(foreign).toEqual(
      expect.objectContaining({
        userId: owner.userId,
        joinedAt: null,
        totalWagered: null,
        totalBets: null,
        currency: null,
      }),
    );
    expect(foreignText).not.toContain(owner.email);
    const ownerCard = PlayerProfileCardSchema.parse(await bodyOf(ownerSeesOwn));
    expect(ownerCard.joinedAt).not.toBeNull();
    expect(ownerCard.currency).not.toBeNull();
  });

  it('one player cannot read the private profile data of another through any player route', async () => {
    const viewer = await newMember('pf-snoop');
    const owner = await newMember('pf-private');
    await owner.client.patch('/profile', {
      firstName: 'Hidden',
      phone: '+48512345678',
      country: 'PL',
    });

    const profile = await readProfile(viewer.client);
    const byId = await viewer.client.get(`/players/${owner.playerId}`);
    const byUser = await viewer.client.get(`/players/by-user/${owner.userId}`);
    const notes = await viewer.client.get(`/player/${owner.playerId}/note`);
    const search = await viewer.client.get(
      `/players/search?q=${encodeURIComponent(owner.email.slice(0, 40))}`,
    );

    expect(profile.userId).toBe(viewer.userId);
    expect([byId.status, byUser.status, notes.status]).toEqual([403, 403, 403]);
    expect(search.status).toBe(200);
    const searchText = await search.text();
    expect(searchText).not.toContain('Hidden');
    expect(searchText).not.toContain('+48512345678');
    expect(searchText).not.toContain(owner.email);
  });

  it.todo(
    'the profile card route is refused for a player session and works for an admin with the permission',
  );
  it.todo('admin responses mask fields the admin has no permission to see');
});
