import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as z from 'zod';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import {
  CountryRuleSchema,
  GameGeoRuleSchema,
  GeoRuleSchema,
  ProviderGeoRuleSchema,
} from '@openora/core/compliance/contract';
import { gameGeoRule, providerGeoRule } from '@openora/core/compliance/schema';
import { game, gameProvider, gameRound, ledgerGame } from '@openora/core/casino/schema/gaming';
import { user } from '@openora/core/pam/schema/identity';
import { bootE2e, closeE2e, newPlayer, uniqueUsername, type E2e } from '../index.js';
import {
  balanceOf,
  bootWalletE2e,
  closeWalletE2e,
  deliverWebhook,
  newDepositScenario,
  waitForAudit,
  type WalletE2e,
} from './support/wallet.js';
import { APPROVED_MIRROR_ORIGIN } from '../test-mirror-target-policy-plugin.js';
import { LICENSED_JURISDICTION } from './support/test-geo-licensed-plugin.js';

const plugin = (id: string, file: string) => ({
  id,
  path: fileURLToPath(new URL(file, import.meta.url)),
});

const DE_IP = '203.0.113.10';
const PL_IP = '203.0.113.20';
const TR_IP = '203.0.113.30';
const UNRESOLVED_IP = '203.0.113.99';

let e2e: WalletE2e;
let failing: E2e;

beforeAll(async () => {
  e2e = await bootWalletE2e([
    plugin('testing-geo-ip', '../test-geo-ip-plugin.ts'),
    plugin('testing-mirror-target-policy', '../test-mirror-target-policy-plugin.ts'),
    plugin('testing-geo-licensed', './support/test-geo-licensed-plugin.ts'),
  ]);
  failing = await bootE2e({
    plugins: [
      ...(await loadExtensions()),
      plugin('testing-geo-ip-failing', './support/test-geo-ip-failing-plugin.ts'),
    ],
  });
}, 120_000);

afterAll(async () => {
  await closeWalletE2e(e2e);
  await closeE2e(failing ?? {});
});

const db = () => e2e.app.container.get(DRIZZLE).db;

const GeoCheckSchema = z.object({
  allowed: z.boolean(),
  countryCode: z.string().nullable(),
  reason: z.string().nullable(),
  redirectUrl: z.string().nullable(),
});

const BulkSchema = z.object({
  changed: z.number(),
  unchanged: z.number(),
  notFound: z.object({ gameIds: z.array(z.string()), providerIds: z.array(z.string()) }),
});

const PageSchema = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item) });

const conflict = expect.objectContaining({ code: 'CONFLICT', status: 409 });

async function bodyOf(res: Response): Promise<unknown> {
  const text = await res.text();
  return text === '' ? null : (JSON.parse(text) as unknown);
}

const from = (ip: string, init: RequestInit = {}) => ({
  ...init,
  headers: { 'content-type': 'application/json', 'x-real-ip': ip },
});

async function geoCheck(ip?: string, headers: Record<string, string> = {}) {
  const res = await e2e.app.app.request('/compliance/geo-check', {
    method: 'GET',
    headers: { ...(ip ? { 'x-real-ip': ip } : {}), ...headers },
  });
  expect(res.status).toBe(200);
  return GeoCheckSchema.parse(await bodyOf(res));
}

async function countryRules() {
  const res = await e2e.admin.get('/compliance/country-rules');
  expect(res.status).toBe(200);
  return z.array(CountryRuleSchema).parse(await bodyOf(res));
}

type RulePatch = {
  blacklisted: boolean;
  redirectIp?: boolean;
  mirrorUrl?: string | null;
  kycRequired?: boolean;
  confirm?: boolean;
  expectedUpdatedAt?: string | null;
};

async function putRule(countryCode: string, patch: RulePatch) {
  const current = (await countryRules()).find((rule) => rule.countryCode === countryCode);
  return e2e.admin.put('/compliance/country-rules', {
    countryCode,
    redirectIp: false,
    kycRequired: true,
    confirm: true,
    expectedUpdatedAt: current?.updatedAt ?? null,
    ...patch,
  });
}

async function openCountry(countryCode: string) {
  const res = await putRule(countryCode, {
    blacklisted: false,
    redirectIp: false,
    mirrorUrl: null,
  });
  expect(res.status).toBe(200);
}

async function withBlockedCountry(countryCode: string, run: () => Promise<void>) {
  const res = await e2e.admin.post('/compliance/geo-rules', { countryCode, action: 'block' });
  expect(res.status).toBe(200);
  try {
    await run();
  } finally {
    await openCountry(countryCode);
  }
}

const registrationBody = (email: string) => ({
  email,
  password: 'password1234',
  username: uniqueUsername('geo'),
  acceptedTerms: true,
  acceptedAge: true,
});

const register = (app: E2e['app'], ip: string, email: string) =>
  app.app.request('/identity/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': ip },
    body: JSON.stringify(registrationBody(email)),
  });

const userRows = (app: E2e['app'], email: string) =>
  app.container.get(DRIZZLE).db.select({ id: user.id }).from(user).where(eq(user.email, email));

async function newGame() {
  const [provider] = await db()
    .insert(gameProvider)
    .values({ slug: `geo-prov-${randomUUID()}`, name: 'Geo Provider', isActive: true })
    .returning();
  const [created] = await db()
    .insert(game)
    .values({
      name: 'Geo Game',
      slug: `geo-game-${randomUUID()}`,
      providerId: provider?.id ?? '',
      aggregator: 'geo-e2e',
      isActive: true,
      reviewStatus: 'approved',
    })
    .returning();
  if (!provider || !created) {
    throw new Error('game seed failed');
  }
  await db()
    .insert(ledgerGame)
    .values({
      gameId: created.id,
      providerId: provider.id,
      gameType: 'casino',
      version: Math.max(created.ledgerVersion, 1),
    });
  return { gameId: created.id, providerId: provider.id };
}

async function fundedBettor(amount = '50') {
  const scenario = await newDepositScenario(e2e, { minDeposit: '1' });
  const res = await deliverWebhook(e2e, scenario.deposit({ amount }));
  expect(res.status).toBe(200);
  await expect
    .poll(() => balanceOf(e2e, scenario.userId, scenario.currency))
    .toBe(`${amount}.000000000000000000`);
  return scenario;
}

const startRound = (bettor: Awaited<ReturnType<typeof fundedBettor>>, gameId: string, ip: string) =>
  bettor.client.request(
    '/gaming/rounds/start',
    from(ip, {
      method: 'POST',
      body: JSON.stringify({ gameId, currency: bettor.currency, betAmount: '1' }),
    }),
  );

const roundRows = (userId: string) =>
  db().select({ id: gameRound.id }).from(gameRound).where(eq(gameRound.userId, userId));

describe('Country blacklist at registration, login and betting', () => {
  it('player from a blacklisted country cannot register and no account is created', async () => {
    const email = `geo-blocked-${randomUUID()}@e2e.test`;
    await withBlockedCountry('TR', async () => {
      const res = await register(e2e.app, TR_IP, email);

      expect(res.status).toBe(403);
    });
    expect(await userRows(e2e.app, email)).toEqual([]);
  });

  it('player from an allowed country registers', async () => {
    const email = `geo-allowed-${randomUUID()}@e2e.test`;
    await withBlockedCountry('TR', async () => {
      const res = await register(e2e.app, PL_IP, email);

      expect(res.status).toBe(200);
    });
    expect(await userRows(e2e.app, email)).toHaveLength(1);
  });

  it('existing player logging in from a blacklisted country is refused', async () => {
    const { email } = await newPlayer(e2e.app, 'geo-login');
    const login = (ip: string) =>
      e2e.app.app.request(
        '/identity/login',
        from(ip, { method: 'POST', body: JSON.stringify({ email, password: 'password1234' }) }),
      );

    await withBlockedCountry('TR', async () => {
      const refused = await login(TR_IP);
      const admitted = await login(PL_IP);

      expect(refused.status).toBe(403);
      expect(refused.headers.get('set-cookie')).toBeNull();
      expect(admitted.status).toBe(200);
    });
  });

  it('player placing a bet from a blacklisted country is refused and the balance is unchanged', async () => {
    const bettor = await fundedBettor();
    const { gameId } = await newGame();

    await withBlockedCountry('TR', async () => {
      const refused = await startRound(bettor, gameId, TR_IP);

      expect(refused.status).toBe(409);
      expect(await bodyOf(refused)).toEqual(
        expect.objectContaining({
          code: 'CONFLICT',
          data: expect.objectContaining({ reason: 'global_block', countryCode: 'TR' }),
        }),
      );
    });
    expect(await balanceOf(e2e, bettor.userId, bettor.currency)).toBe('50.000000000000000000');
    expect(await roundRows(bettor.userId)).toEqual([]);
    const admitted = await startRound(bettor, gameId, PL_IP);
    expect(admitted.status).toBe(200);
    expect(await balanceOf(e2e, bettor.userId, bettor.currency)).toBe('49.000000000000000000');
  });

  it('player launching a game that is restricted for their country is refused', async () => {
    const bettor = await fundedBettor();
    const { gameId } = await newGame();
    const restricted = await e2e.admin.put(`/compliance/game-geo-rules/${gameId}`, {
      gameId,
      countryCodes: ['DE'],
      reason: 'licence gap',
    });
    expect(restricted.status).toBe(200);

    const refused = await startRound(bettor, gameId, DE_IP);
    const admitted = await startRound(bettor, gameId, PL_IP);

    expect(refused.status).toBe(409);
    expect(await bodyOf(refused)).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ reason: 'game_block', countryCode: 'DE' }),
      }),
    );
    expect(admitted.status).toBe(200);
    expect(await roundRows(bettor.userId)).toHaveLength(1);
  });

  it('removing a country from the blacklist lets the player in on the next request', async () => {
    await withBlockedCountry('TR', async () => {
      expect((await geoCheck(TR_IP)).allowed).toBe(false);

      const unblocked = await e2e.admin.post('/compliance/geo-rules', {
        countryCode: 'TR',
        action: 'allow',
      });

      expect(unblocked.status).toBe(200);
      expect((await geoCheck(TR_IP)).allowed).toBe(true);
    });
  });

  it('a blacklisted country with a mirror redirect target is reported as redirected, not blocked', async () => {
    try {
      const res = await putRule('TR', {
        blacklisted: true,
        redirectIp: true,
        mirrorUrl: APPROVED_MIRROR_ORIGIN,
      });

      expect(res.status).toBe(200);
      expect(CountryRuleSchema.parse(await bodyOf(res)).effectiveAccess).toBe('redirected');
      expect(await geoCheck(TR_IP)).toEqual({
        allowed: true,
        countryCode: 'TR',
        reason: null,
        redirectUrl: APPROVED_MIRROR_ORIGIN,
      });
      const listed = await e2e.admin.get('/compliance/geo-rules');
      const rules = z
        .array(GeoRuleSchema.extend({ effectiveAccess: z.string() }))
        .parse(await bodyOf(listed));
      expect(rules.find((rule) => rule.countryCode === 'TR')).toEqual(
        expect.objectContaining({ action: 'block', effectiveAccess: 'redirected' }),
      );
    } finally {
      await openCountry('TR');
    }
  });

  it('a blacklist rule with the redirect flag but an empty mirror target still blocks', async () => {
    try {
      const res = await putRule('TR', { blacklisted: true, redirectIp: true, mirrorUrl: null });

      expect(res.status).toBe(200);
      expect(CountryRuleSchema.parse(await bodyOf(res)).effectiveAccess).toBe('blocked');
      expect(await geoCheck(TR_IP)).toEqual(
        expect.objectContaining({ allowed: false, countryCode: 'TR', redirectUrl: null }),
      );
    } finally {
      await openCountry('TR');
    }
  });

  it('geo check with an unresolvable country blocks instead of letting the player through', async () => {
    const before = await geoCheck(UNRESOLVED_IP);
    expect(before.allowed).toBe(true);

    await withBlockedCountry('TR', async () => {
      expect(await geoCheck(UNRESOLVED_IP)).toEqual({
        allowed: false,
        countryCode: null,
        reason: 'Geolocation could not be determined',
        redirectUrl: null,
      });
      const email = `geo-unresolved-${randomUUID()}@e2e.test`;
      expect((await register(e2e.app, UNRESOLVED_IP, email)).status).toBe(403);
      expect(await userRows(e2e.app, email)).toEqual([]);
    });
  });

  it('geo check when the geo lookup provider fails blocks instead of failing open', async () => {
    const email = `geo-provider-down-${randomUUID()}@e2e.test`;

    const check = await failing.app.app.request('/compliance/geo-check', {
      method: 'GET',
      headers: { 'x-real-ip': PL_IP },
    });
    const registered = await register(failing.app, PL_IP, email);

    expect(check.status).toBeGreaterThanOrEqual(500);
    expect(GeoCheckSchema.safeParse(await bodyOf(check)).success).toBe(false);
    expect(registered.status).toBeGreaterThanOrEqual(500);
    expect(await userRows(failing.app, email)).toEqual([]);
  });

  it('geo check with a missing or spoofed forwarded address does not grant access', async () => {
    await withBlockedCountry('TR', async () => {
      const missing = await geoCheck();
      const spoofedForUnresolved = await geoCheck(undefined, { 'x-forwarded-for': PL_IP });
      const spoofedForBlocked = await geoCheck(TR_IP, { 'x-forwarded-for': PL_IP });

      expect(missing.allowed).toBe(false);
      expect(spoofedForUnresolved.allowed).toBe(false);
      expect(spoofedForBlocked).toEqual(
        expect.objectContaining({ allowed: false, countryCode: 'TR' }),
      );
    });
  });

  it('player geo-check route returns the effective access for the caller country', async () => {
    await withBlockedCountry('TR', async () => {
      expect(await geoCheck(PL_IP)).toEqual({
        allowed: true,
        countryCode: 'PL',
        reason: null,
        redirectUrl: null,
      });
      expect(await geoCheck(TR_IP)).toEqual({
        allowed: false,
        countryCode: 'TR',
        reason: 'Country TR is blocked',
        redirectUrl: null,
      });
    });
  });
});

describe('Geo rule administration', () => {
  it('admin blacklists a country and the rule is listed with the audit row', async () => {
    try {
      const res = await e2e.admin.post('/compliance/geo-rules', {
        countryCode: 'KI',
        action: 'block',
      });

      expect(res.status).toBe(200);
      expect(GeoRuleSchema.parse(await bodyOf(res))).toEqual(
        expect.objectContaining({ countryCode: 'KI', action: 'block' }),
      );
      const listed = z
        .array(GeoRuleSchema)
        .parse(await bodyOf(await e2e.admin.get('/compliance/geo-rules')));
      expect(listed).toContainEqual(
        expect.objectContaining({ countryCode: 'KI', action: 'block' }),
      );
      const audit = await waitForAudit(e2e, 'compliance.country_rule.setting_changed', 'KI');
      expect(audit).toContainEqual(
        expect.objectContaining({ after: { setting: 'blacklisted', value: true } }),
      );
    } finally {
      await openCountry('KI');
    }
  });

  it('admin cannot blacklist a licensed jurisdiction and gets a conflict', async () => {
    const res = await e2e.admin.post('/compliance/geo-rules', {
      countryCode: LICENSED_JURISDICTION,
      action: 'block',
    });

    expect(res.status).toBe(409);
    expect(await bodyOf(res)).toEqual(conflict);
    expect(await geoCheck(UNRESOLVED_IP)).toEqual(expect.objectContaining({ allowed: true }));
  });

  it('admin saving a rule that changes access without confirmation is asked to confirm', async () => {
    const res = await putRule('NR', { blacklisted: true, confirm: false });

    expect(res.status).toBe(409);
    expect(await bodyOf(res)).toEqual(conflict);
    const stored = (await countryRules()).find((rule) => rule.countryCode === 'NR');
    expect(stored?.blacklisted ?? false).toBe(false);
  });

  it('admin saving a country rule with a stale version gets a version conflict', async () => {
    try {
      const created = await putRule('TV', { blacklisted: true });
      expect(created.status).toBe(200);

      const stale = await putRule('TV', {
        blacklisted: false,
        expectedUpdatedAt: '2000-01-01T00:00:00.000Z',
      });

      expect(stale.status).toBe(409);
      expect(await bodyOf(stale)).toEqual(conflict);
      const stored = (await countryRules()).find((rule) => rule.countryCode === 'TV');
      expect(stored?.blacklisted).toBe(true);
    } finally {
      await openCountry('TV');
    }
  });

  it('admin sets a mirror target that is not approved and is refused', async () => {
    const res = await putRule('PW', {
      blacklisted: true,
      redirectIp: true,
      mirrorUrl: 'https://unapproved.e2e.test',
    });

    expect(res.status).toBe(409);
    expect(await bodyOf(res)).toEqual(conflict);
    const stored = (await countryRules()).find((rule) => rule.countryCode === 'PW');
    expect(stored?.mirrorUrl ?? null).toBeNull();
    expect(stored?.blacklisted ?? false).toBe(false);
  });

  it('admin restricts and unrestricts a game for a country, then reads the rule list', async () => {
    const { gameId } = await newGame();
    const gameRulesUrl = `/compliance/game-geo-rules/${gameId}`;

    const restricted = await e2e.admin.put(gameRulesUrl, {
      gameId,
      countryCodes: ['DE', 'PL'],
      reason: 'licence gap',
    });
    const afterRestrict = await e2e.admin.get(`/compliance/game-geo-rules?gameIds[0]=${gameId}`);
    const unrestricted = await e2e.admin.request(
      gameRulesUrl,
      from(DE_IP, {
        method: 'DELETE',
        body: JSON.stringify({ gameId, countryCodes: ['DE'], reason: 'licence granted' }),
      }),
    );
    const afterUnrestrict = await e2e.admin.get(`/compliance/game-geo-rules?gameIds[0]=${gameId}`);

    expect(restricted.status).toBe(200);
    expect(z.array(GameGeoRuleSchema).parse(await bodyOf(restricted))).toHaveLength(2);
    const listed = (res: unknown) =>
      PageSchema(GameGeoRuleSchema)
        .parse(res)
        .items.map((rule) => rule.countryCode)
        .sort();
    expect(listed(await bodyOf(afterRestrict))).toEqual(['DE', 'PL']);
    expect(unrestricted.status).toBe(200);
    expect(listed(await bodyOf(afterUnrestrict))).toEqual(['PL']);
    const stored = await db().select().from(gameGeoRule).where(eq(gameGeoRule.gameId, gameId));
    expect(stored.map((rule) => rule.countryCode)).toEqual(['PL']);
  });

  it('admin bulk-restricts games and providers and a missing country code is reported', async () => {
    const first = await newGame();
    const second = await newGame();
    const missingGameId = randomUUID();

    const restricted = await e2e.admin.post('/compliance/game-geo-rules/bulk/restrict', {
      gameIds: [first.gameId, missingGameId],
      providerIds: [second.providerId],
      countryCode: 'DE',
      reason: 'bulk licence gap',
    });
    const noCountry = await e2e.admin.post('/compliance/game-geo-rules/bulk/restrict', {
      gameIds: [first.gameId],
      reason: 'bulk licence gap',
    });

    expect(restricted.status).toBe(200);
    const outcome = BulkSchema.parse(await bodyOf(restricted));
    expect(outcome.changed).toBe(2);
    expect(outcome.notFound.gameIds).toEqual([missingGameId]);
    expect(noCountry.status).toBe(400);
    const stored = await db().select().from(gameGeoRule).where(eq(gameGeoRule.countryCode, 'DE'));
    const storedIds = stored.map((rule) => rule.gameId);
    expect(storedIds).toEqual(expect.arrayContaining([first.gameId, second.gameId]));
  });

  it('admin sets and removes a provider geo rule and a missing provider returns not found', async () => {
    const { providerId } = await newGame();
    const providerRulesUrl = `/compliance/provider-geo-rules/${providerId}`;

    const set = await e2e.admin.put(providerRulesUrl, {
      providerId,
      countryCodes: ['DE'],
      reason: 'provider licence gap',
    });
    const removed = await e2e.admin.request(
      providerRulesUrl,
      from(DE_IP, {
        method: 'DELETE',
        body: JSON.stringify({
          providerId,
          countryCodes: ['DE'],
          reason: 'provider licence granted',
        }),
      }),
    );
    const missingId = randomUUID();
    const missing = await e2e.admin.put(`/compliance/provider-geo-rules/${missingId}`, {
      providerId: missingId,
      countryCodes: ['DE'],
      reason: 'provider licence gap',
    });

    expect(set.status).toBe(200);
    expect(z.array(ProviderGeoRuleSchema).parse(await bodyOf(set))).toHaveLength(1);
    expect(removed.status).toBe(200);
    expect(
      await db().select().from(providerGeoRule).where(eq(providerGeoRule.providerId, providerId)),
    ).toEqual([]);
    expect(missing.status).toBe(404);
  });

  it('player and anonymous callers cannot read or write geo rules', async () => {
    const { client } = await newPlayer(e2e.app, 'geo-player');
    const { gameId } = await newGame();
    const attempts = (caller: { request: typeof client.request }) => [
      caller.request('/compliance/geo-rules', { method: 'GET' }),
      caller.request(
        '/compliance/geo-rules',
        from(PL_IP, {
          method: 'POST',
          body: JSON.stringify({ countryCode: 'NR', action: 'block' }),
        }),
      ),
      caller.request(
        `/compliance/game-geo-rules/${gameId}`,
        from(PL_IP, {
          method: 'PUT',
          body: JSON.stringify({ gameId, countryCodes: ['NR'], reason: 'nope' }),
        }),
      ),
    ];

    const asPlayer = await Promise.all(attempts(client));
    const anonymous = await Promise.all(
      attempts({ request: async (path, init) => e2e.app.app.request(path, init) }),
    );

    expect(asPlayer.map((res) => res.status)).toEqual([403, 403, 403]);
    expect(anonymous.map((res) => res.status)).toEqual([401, 401, 401]);
    expect((await countryRules()).find((rule) => rule.countryCode === 'NR')).toBeUndefined();
    expect(await db().select().from(gameGeoRule).where(eq(gameGeoRule.gameId, gameId))).toEqual([]);
  });
});
