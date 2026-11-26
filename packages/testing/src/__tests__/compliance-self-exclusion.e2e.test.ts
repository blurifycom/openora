import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { user } from '@openora/core/pam/schema/identity';
import { JOB_QUEUE, WALLET_COMMANDS, queue } from '@openora/core/contracts';
import { DRIZZLE } from '@openora/core/server';
import { rgExclusion } from '@openora/core/compliance/schema';
import { asPlayer } from '../index.js';
import {
  balanceOf,
  bootWalletE2e,
  closeWalletE2e,
  newFundedPlayer,
  waitForAudit,
  type WalletE2e,
} from './support/wallet.js';
import {
  complianceManager,
  emailOf,
  exclusionRows,
  fundPlayer,
  newRgPlayer,
  parseExclusion,
  placeBet,
  postDeposit,
  readBody,
  readOnlyAdmin,
  rgSection,
  scaled,
  type RgPlayer,
} from './support/compliance.js';

let e2e: WalletE2e;

beforeAll(async () => {
  e2e = await bootWalletE2e();
  const config = await e2e.admin.get('/wallet/auto-withdrawal-config');
  if (config.status !== 200) {
    const created = await e2e.admin.put('/wallet/auto-withdrawal-config', {
      fiatThreshold: '0',
      cryptoThreshold: '0',
      excludeRiskFlags: [],
      velocityCount: null,
      velocityWindowHours: 24,
    });
    if (created.status !== 200) {
      throw new Error(`auto-withdrawal config failed (${created.status})`);
    }
  }
}, 60_000);

afterAll(() => closeWalletE2e(e2e));

const db = () => e2e.app.container.get(DRIZZLE).db;

const conflict = (message: string) =>
  expect.objectContaining({ code: 'CONFLICT', status: 409, message });

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000);

async function elapsePeriod(userId: string) {
  await db()
    .update(rgExclusion)
    .set({ startsAt: hoursAgo(72), expiresAt: hoursAgo(1) })
    .where(and(eq(rgExclusion.userId, userId), eq(rgExclusion.status, 'active')));
}

async function runExpirySweep(userId: string) {
  await e2e.app.container.get(JOB_QUEUE).enqueue(queue('rg-monitor'), {});
  await vi.waitFor(
    async () => {
      const [row] = await db()
        .select({ rgBlocked: user.rgBlocked })
        .from(user)
        .where(eq(user.id, userId));
      expect(row?.rgBlocked).toBe(false);
    },
    { timeout: 10_000 },
  );
}

async function elapseCoolingOff(userId: string) {
  await elapsePeriod(userId);
  await runExpirySweep(userId);
}

async function loginAttempt(player: RgPlayer) {
  const email = await emailOf(e2e, player.userId);
  return e2e.app.app.request('/identity/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'password1234' }),
  });
}

const startCoolingOff = (player: RgPlayer, durationHours = 24) =>
  player.client.post('/compliance/rg/cooling-off', { durationHours }).then(readBody);

const startSelfExclusion = (player: RgPlayer, overrides: Record<string, unknown> = {}) =>
  player.client
    .post('/compliance/rg/self-exclusion', {
      isPermanent: false,
      durationMonths: 6,
      confirm: true,
      ...overrides,
    })
    .then(readBody);

const adminCoolingOff = (player: RgPlayer, durationHours = 24) =>
  e2e.admin
    .post(`/compliance/players/${player.userId}/cooling-off`, { durationHours, reason: 'e2e' })
    .then(readBody);

const adminSelfExclusion = (
  player: RgPlayer,
  overrides: Record<string, unknown> = {},
  client = e2e.admin,
) =>
  client
    .post(`/compliance/players/${player.userId}/self-exclusion`, {
      isPermanent: false,
      durationMonths: 6,
      reason: 'e2e',
      confirm: true,
      ...overrides,
    })
    .then(readBody);

const adminLiftSelfExclusion = (player: RgPlayer, client = e2e.admin) =>
  client
    .post(`/compliance/players/${player.userId}/self-exclusion/lift`, {
      reason: 'e2e lift',
      confirm: true,
    })
    .then(readBody);

const adminLiftCoolingOff = (player: RgPlayer, client = e2e.admin) =>
  client
    .post(`/compliance/players/${player.userId}/cooling-off/lift`, { reason: 'e2e lift' })
    .then(readBody);

describe('Cooling-off', () => {
  it('player starts a cooling-off period and cannot deposit or bet until it ends', async () => {
    const player = await newRgPlayer(e2e);
    await fundPlayer(e2e, player, '100');

    const started = await startCoolingOff(player);

    expect(started.status).toBe(200);
    const exclusion = parseExclusion(started.body);
    expect(exclusion.kind).toBe('cooling_off');
    expect(exclusion.status).toBe('active');
    expect((await postDeposit(player.client, player.currency, '10')).status).toBe(401);
    expect((await loginAttempt(player)).status).toBe(403);
    await expect(placeBet(e2e, player.userId, player.currency, '10')).rejects.toMatchObject({
      name: 'WalletRgRestrictedError',
    });
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(scaled('100'));
  });

  it('cooling-off with a duration outside the allowed range is refused', async () => {
    const player = await newRgPlayer(e2e);

    const tooShort = await startCoolingOff(player, 12);
    const between = await startCoolingOff(player, 48);
    const tooLong = await startCoolingOff(player, 2000);

    expect([tooShort.status, between.status, tooLong.status]).toEqual([400, 400, 400]);
    expect(await exclusionRows(e2e, player.userId)).toEqual([]);
    const section = await rgSection(player.client);
    expect(section.coolingOff).toBeNull();
  });

  it('player starts cooling-off twice and gets an active-exclusion conflict', async () => {
    const player = await newRgPlayer(e2e);
    const first = await startCoolingOff(player);
    expect(first.status).toBe(200);

    const second = await adminCoolingOff(player);

    expect(second.status).toBe(409);
    expect(second.body).toEqual(
      conflict('An active exclusion of this kind already exists for this player'),
    );
    const rows = await exclusionRows(e2e, player.userId);
    expect(rows).toHaveLength(1);
  });

  it('cooling-off ends on its own once the period has elapsed and the player plays again', async () => {
    const player = await newRgPlayer(e2e);
    await fundPlayer(e2e, player, '100');
    await startCoolingOff(player);
    expect((await loginAttempt(player)).status).toBe(403);

    await elapseCoolingOff(player.userId);

    const email = await emailOf(e2e, player.userId);
    const client = await asPlayer(e2e.app.app, { email });
    expect((await postDeposit(client, player.currency, '10')).status).toBe(200);
    await placeBet(e2e, player.userId, player.currency, '10');
    expect((await rgSection(client)).coolingOff).toBeNull();
  });

  it('admin lifts a cooling-off period and the lift is audited', async () => {
    const player = await newRgPlayer(e2e);
    await startCoolingOff(player);
    const manager = await complianceManager(e2e);

    const lifted = await adminLiftCoolingOff(player, manager);

    expect(lifted.status).toBe(200);
    const rows = await exclusionRows(e2e, player.userId);
    expect(rows).toEqual([expect.objectContaining({ kind: 'cooling_off', status: 'lifted' })]);
    const audit = await waitForAudit(e2e, 'rg.cooling_off.lifted', player.playerId);
    expect(audit[0]).toEqual(expect.objectContaining({ resourceType: 'player' }));
    expect((await loginAttempt(player)).status).toBe(200);
  });

  it('an admin without the compliance permission lifting a cooling-off period is refused as forbidden', async () => {
    const player = await newRgPlayer(e2e);
    await startCoolingOff(player);
    const readOnly = await readOnlyAdmin(e2e);

    const lift = await adminLiftCoolingOff(player, readOnly);

    expect(lift.status).toBe(403);
    const rows = await exclusionRows(e2e, player.userId);
    expect(rows).toEqual([expect.objectContaining({ status: 'active' })]);
    expect((await loginAttempt(player)).status).toBe(403);
  });
});

describe('Self-exclusion', () => {
  it('player self-excludes and every active session is ended at once', async () => {
    const player = await newRgPlayer(e2e);
    const email = await emailOf(e2e, player.userId);
    const second = await asPlayer(e2e.app.app, { email });
    expect((await second.get('/compliance/rg/me')).status).toBe(200);

    const started = await startSelfExclusion(player);

    expect(started.status).toBe(200);
    expect(parseExclusion(started.body).kind).toBe('self_exclusion');
    expect((await player.client.get('/compliance/rg/me')).status).toBe(401);
    expect((await second.get('/compliance/rg/me')).status).toBe(401);
  });

  it('player self-excluded cannot log in, deposit or bet', async () => {
    const player = await newRgPlayer(e2e);
    await fundPlayer(e2e, player, '100');

    await startSelfExclusion(player);

    expect((await loginAttempt(player)).status).toBe(403);
    expect((await postDeposit(player.client, player.currency, '10')).status).toBe(401);
    await expect(placeBet(e2e, player.userId, player.currency, '10')).rejects.toMatchObject({
      name: 'WalletRgRestrictedError',
    });
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(scaled('100'));
  });

  it.todo(
    'a custody deposit webhook for a self-excluded player is held, not credited to the balance',
  );

  it.todo(
    'self-exclusion forfeits every active bonus and the bonus balance is zeroed with a ledger row',
  );

  it.todo('a self-excluded player can still withdraw their real-money balance');

  it('the ledger RG gate refuses a bet but not a withdrawal debit during self-exclusion', async () => {
    const player = await newFundedPlayer(e2e, '100');

    await startSelfExclusion(player);

    await expect(placeBet(e2e, player.userId, player.currency, '10')).rejects.toMatchObject({
      name: 'WalletRgRestrictedError',
    });
    const outcome = await db().transaction((tx) =>
      e2e.app.container.get(WALLET_COMMANDS).debit(tx, {
        userId: player.userId,
        amount: '40',
        type: 'withdrawal',
        currency: player.currency,
      }),
    );
    expect(outcome).toMatchObject({ ok: true, moved: true });
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(scaled('60'));
  });

  it('permanent self-exclusion cannot be lifted by an admin', async () => {
    const player = await newRgPlayer(e2e);
    const started = await startSelfExclusion(player, {
      isPermanent: true,
      durationMonths: undefined,
    });
    expect(parseExclusion(started.body).expiresAt).toBeNull();
    const manager = await complianceManager(e2e);

    const lift = await adminLiftSelfExclusion(player, manager);

    expect(lift.status).toBe(409);
    expect(lift.body).toEqual(expect.objectContaining({ code: 'CONFLICT', status: 409 }));
    const rows = await exclusionRows(e2e, player.userId);
    expect(rows).toEqual([expect.objectContaining({ isPermanent: true, status: 'active' })]);
    expect((await loginAttempt(player)).status).toBe(403);
  });

  it('admin lifting a fixed-period self-exclusion before it elapsed is refused', async () => {
    const player = await newRgPlayer(e2e);
    await startSelfExclusion(player);
    const manager = await complianceManager(e2e);

    const lift = await adminLiftSelfExclusion(player, manager);

    expect(lift.status).toBe(409);
    expect(lift.body).toEqual(expect.objectContaining({ code: 'CONFLICT', status: 409 }));
    const rows = await exclusionRows(e2e, player.userId);
    expect(rows).toEqual([expect.objectContaining({ status: 'active' })]);
    expect((await loginAttempt(player)).status).toBe(403);
  });

  it('admin lifting a self-exclusion after its period elapsed reopens the account', async () => {
    const player = await newRgPlayer(e2e);
    await startSelfExclusion(player);
    await elapsePeriod(player.userId);
    const manager = await complianceManager(e2e);

    const lift = await adminLiftSelfExclusion(player, manager);

    expect(lift.status).toBe(200);
    const rows = await exclusionRows(e2e, player.userId);
    expect(rows).toEqual([expect.objectContaining({ status: 'lifted' })]);
    const email = await emailOf(e2e, player.userId);
    const client = await asPlayer(e2e.app.app, { email });
    expect((await rgSection(client)).selfExclusion).toBeNull();
  });

  it('player self-excludes twice and gets an active-exclusion conflict', async () => {
    const player = await newRgPlayer(e2e);
    expect((await startSelfExclusion(player)).status).toBe(200);

    const second = await adminSelfExclusion(player);

    expect(second.status).toBe(409);
    expect(second.body).toEqual(
      conflict('An active exclusion of this kind already exists for this player'),
    );
    expect(await exclusionRows(e2e, player.userId)).toHaveLength(1);
  });

  it('player cannot start or lift an exclusion for another player', async () => {
    const attacker = await newRgPlayer(e2e);
    const victim = await newRgPlayer(e2e);

    const start = await adminSelfExclusion(victim, {}, attacker.client);
    const cooling = await attacker.client
      .post(`/compliance/players/${victim.userId}/cooling-off`, { durationHours: 24, reason: 'x' })
      .then(readBody);
    const lift = await adminLiftSelfExclusion(victim, attacker.client);

    expect([start.status, cooling.status, lift.status]).toEqual([403, 403, 403]);
    expect(await exclusionRows(e2e, victim.userId)).toEqual([]);
    expect((await victim.client.get('/compliance/rg/me')).status).toBe(200);
    expect((await attacker.client.get('/compliance/rg/me')).status).toBe(200);
  });

  it('self-exclusion and cooling-off are listed in the player rg history with dates', async () => {
    const player = await newRgPlayer(e2e);
    await startCoolingOff(player);
    await adminLiftCoolingOff(player);
    const started = parseExclusion((await adminSelfExclusion(player)).body);

    const rows = await exclusionRows(e2e, player.userId);

    expect(rows.map((row) => [row.kind, row.status]).sort()).toEqual([
      ['cooling_off', 'lifted'],
      ['self_exclusion', 'active'],
    ]);
    for (const row of rows) {
      expect(row.startsAt).toBeInstanceOf(Date);
      expect(row.expiresAt).toBeInstanceOf(Date);
    }
    const view = await readBody(await e2e.admin.get(`/compliance/players/${player.userId}/rg`));
    expect(view.status).toBe(200);
    expect(view.body).toEqual(
      expect.objectContaining({
        selfExclusion: expect.objectContaining({
          id: started.id,
          startsAt: started.startsAt,
          expiresAt: started.expiresAt,
        }),
        coolingOff: null,
      }),
    );
  });
});
