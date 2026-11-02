import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { PLAYER_TAGS, WALLET_COMMANDS } from '@openora/core/contracts';
import { player } from '@openora/core/pam/schema/profile';
import { kycVerification } from '@openora/core/compliance/schema';
import {
  registerAndMaterializePlayer,
  type E2e,
  type TestClient,
  bootE2e,
  closeE2e,
  readJson,
} from '../index.js';
import { AGE_REVIEW_REFUSAL, MIN_PLAYER_AGE } from './fixtures/test-age-verification-plugin.js';

const KYC_WEBHOOK_SECRET = 'e2e-age-kyc-webhook-secret';

let e2e: E2e | undefined;
let app: E2e['app'];

function yearsAgo(years: number, extraDays = 0): string {
  const now = new Date();
  const year = now.getUTCFullYear() - years;
  const lastDayOfMonth = new Date(Date.UTC(year, now.getUTCMonth() + 1, 0)).getUTCDate();
  const day = Math.min(now.getUTCDate(), lastDayOfMonth) + extraDays;
  return new Date(Date.UTC(year, now.getUTCMonth(), day)).toISOString().slice(0, 10);
}

function depositUsd(client: TestClient) {
  return client.post('/wallet/deposit', {
    idempotencyKey: randomUUID(),
    amount: '2',
    currency: 'USD',
  });
}

async function newPlayer(label: string) {
  return registerAndMaterializePlayer(app, { email: `age-${label}-${randomUUID()}@e2e.test` });
}

async function submitKyc(client: TestClient): Promise<string> {
  const res = await client.post('/compliance/kyc', {
    tier: 'basic',
    documents: [{ type: 'passport', frontUrl: 'https://example.test/front.jpg' }],
  });
  expect(res.status).toBe(200);
  return (await readJson(res)).referenceId as string;
}

async function deliverDecision(referenceId: string, dateOfBirth: string) {
  const body = JSON.stringify({ referenceId, status: 'approved', dateOfBirth });
  const res = await app.app.request('/compliance/kyc/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-kyc-signature': `sha256=${createHmac('sha256', KYC_WEBHOOK_SECRET).update(body, 'utf8').digest('hex')}`,
    },
    body,
  });
  expect(res.status).toBe(200);
}

async function tagsOf(userId: string) {
  return (await app.container.get(PLAYER_TAGS).getActiveTagKeys([userId])).get(userId) ?? [];
}

async function statusOf(userId: string) {
  const [row] = await app.container
    .get(DRIZZLE)
    .db.select({ status: player.status })
    .from(player)
    .where(eq(player.userId, userId));
  return row?.status;
}

beforeAll(async () => {
  process.env['KYC_WEBHOOK_SECRET'] = KYC_WEBHOOK_SECRET;
  const fixture = fileURLToPath(
    new URL('./fixtures/test-age-verification-plugin.ts', import.meta.url),
  );
  e2e = await bootE2e({
    plugins: [...(await loadExtensions()), { id: 'test-age-verification', path: fixture }],
  });
  app = e2e.app;
}, 60_000);

afterAll(async () => {
  if (e2e) {
    await closeE2e(e2e);
  }
});

describe('registration policy', () => {
  it('tells an anonymous caller the configured minimum age and nothing else', async () => {
    const res = await app.app.request('/identity/registration-policy');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ minPlayerAge: MIN_PLAYER_AGE });
  });
});

describe('profile date of birth', () => {
  it('stores a date at the configured age and refuses one a day short of it', async () => {
    const { client } = await newPlayer('profile');

    const tooYoung = await client.patch('/profile', { dateOfBirth: yearsAgo(MIN_PLAYER_AGE, 1) });
    expect(tooYoung.status).toBe(400);
    expect(await readJson(tooYoung)).toMatchObject({
      code: 'BAD_REQUEST',
      message: `Player must be at least ${MIN_PLAYER_AGE} years old`,
      data: { reason: 'underage', field: 'dateOfBirth' },
    });

    const ofAge = await client.patch('/profile', { dateOfBirth: yearsAgo(MIN_PLAYER_AGE) });
    expect(ofAge.status).toBe(200);
    expect((await readJson(ofAge)).dateOfBirth).toBe(yearsAgo(MIN_PLAYER_AGE));
  });

  it.each([null, '1985-03-03'])('refuses changing a stored date of birth to %s', async (next) => {
    const { client } = await newPlayer('locked');
    expect((await client.patch('/profile', { dateOfBirth: '1990-01-01' })).status).toBe(200);

    const changed = await client.patch('/profile', { dateOfBirth: next });

    expect(changed.status).toBe(400);
    expect(await readJson(changed)).toMatchObject({
      data: { reason: 'date_of_birth_locked', field: 'dateOfBirth' },
    });
    expect((await readJson(await client.get('/profile'))).dateOfBirth).toBe('1990-01-01');
  });
});

describe('KYC verified date of birth', () => {
  it('suspends an under-age player, ends their sessions, tags them and refuses a wager', async () => {
    const { client, userId } = await newPlayer('underage');
    expect((await client.patch('/profile', { dateOfBirth: '1990-01-01' })).status).toBe(200);
    const referenceId = await submitKyc(client);

    await deliverDecision(referenceId, yearsAgo(MIN_PLAYER_AGE - 1));

    await vi.waitFor(
      async () => {
        expect(await statusOf(userId)).toBe('suspended');
        expect(await tagsOf(userId)).toContain('age_verification_review');
        expect((await client.get('/profile')).status).toBe(401);
      },
      { timeout: 15_000 },
    );
    expect(await tagsOf(userId)).not.toContain('kyc_dob_mismatch');

    const drizzle = app.container.get(DRIZZLE);
    await expect(
      drizzle.db.transaction((tx) =>
        app.container
          .get(WALLET_COMMANDS)
          .debit(tx, { userId, amount: '1', currency: 'USD', type: 'bet' }),
      ),
    ).rejects.toMatchObject({ name: 'WalletRgRestrictedError' });
  });

  it('tags an adult whose verified date differs and refuses them any deposit', async () => {
    const { client, userId } = await newPlayer('mismatch');
    expect((await client.patch('/profile', { dateOfBirth: '1990-01-01' })).status).toBe(200);
    const referenceId = await submitKyc(client);

    await deliverDecision(referenceId, '1988-05-05');

    await vi.waitFor(async () => expect(await tagsOf(userId)).toContain('kyc_dob_mismatch'), {
      timeout: 15_000,
    });
    expect(await statusOf(userId)).toBe('active');

    for (const refused of [
      await client.post('/wallet/deposits/address', { currency: 'USD' }),
      await depositUsd(client),
    ]) {
      expect(refused.status).toBe(403);
      expect(await readJson(refused)).toMatchObject({
        code: 'FORBIDDEN',
        data: { reason: AGE_REVIEW_REFUSAL },
      });
    }
  });

  it('adds nothing when the verified date matches the declared one', async () => {
    const { client, userId } = await newPlayer('match');
    expect((await client.patch('/profile', { dateOfBirth: '1990-01-01' })).status).toBe(200);
    const referenceId = await submitKyc(client);

    await deliverDecision(referenceId, '1990-01-01');

    await vi.waitFor(async () => {
      const [row] = await app.container
        .get(DRIZZLE)
        .db.select({ status: kycVerification.status })
        .from(kycVerification)
        .where(eq(kycVerification.referenceId, referenceId));
      expect(row?.status).toBe('approved');
    });
    expect(await tagsOf(userId)).toEqual([]);
    expect(await statusOf(userId)).toBe('active');
    expect((await depositUsd(client)).status).toBe(200);
  });
});
