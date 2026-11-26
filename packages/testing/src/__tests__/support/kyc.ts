import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, vi } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import * as z from 'zod';
import { DRIZZLE } from '@openora/core/server';
import { kycVerification } from '@openora/core/compliance/schema';
import { player } from '@openora/core/pam/schema/profile';
import { KycStatusUpdateSchema, PlayerKycViewSchema } from '@openora/core/compliance/contract';
import { asPlayer, newPlayer, newStaff, verifyEmailByOtp, type TestClient } from '../../index.js';
import { registrationRequestHeaders } from '../../request.js';
import { wallet, walletTransaction } from '@openora/core/wallet/schema';
import { exchangeRateQuote } from '@openora/core/fx/schema/exchange-rate';
import {
  addAsset,
  bootWalletE2e,
  closeWalletE2e,
  deliverWebhook,
  NETWORK,
  RATE,
  requestDepositAddress,
  type WalletE2e,
} from './wallet.js';
import { directiveSegment, type KycDirective } from './test-kyc-plugin.js';

export const KYC_WEBHOOK_SECRET = 'e2e-kyc-webhook-secret';

const kycPlugin = {
  id: 'testing-kyc',
  path: fileURLToPath(new URL('./test-kyc-plugin.ts', import.meta.url)),
};

export async function bootKycE2e() {
  const previous = process.env['KYC_WEBHOOK_SECRET'];
  process.env['KYC_WEBHOOK_SECRET'] = KYC_WEBHOOK_SECRET;
  try {
    return await bootWalletE2e([kycPlugin]);
  } catch (err) {
    restoreSecret(previous);
    throw err;
  }
}

const restoreSecret = (previous: string | undefined) => {
  if (previous === undefined) {
    delete process.env['KYC_WEBHOOK_SECRET'];
  } else {
    process.env['KYC_WEBHOOK_SECRET'] = previous;
  }
};

export async function closeKycE2e(e2e: WalletE2e | undefined) {
  await closeWalletE2e(e2e);
  delete process.env['KYC_WEBHOOK_SECRET'];
}

export const documentsFor = (directive: KycDirective = {}) => [
  { type: 'passport', frontUrl: `https://e2e.test/${directiveSegment(directive)}` },
];

export async function submitKyc(
  client: TestClient,
  directive: KycDirective = {},
  tier: 'basic' | 'advanced' = 'basic',
) {
  const res = await client.post('/compliance/kyc', { tier, documents: documentsFor(directive) });
  return { status: res.status, body: (await res.json()) as unknown };
}

const SubmittedSchema = z.object({ referenceId: z.string(), status: z.string() });

export async function submitKycOrThrow(
  client: TestClient,
  directive: KycDirective = {},
  tier: 'basic' | 'advanced' = 'basic',
) {
  const { status, body } = await submitKyc(client, directive, tier);
  if (status !== 200) {
    throw new Error(`kyc submit failed (${status}): ${JSON.stringify(body)}`);
  }
  return SubmittedSchema.parse(body);
}

export const signKycBody = (rawBody: string) =>
  createHmac('sha256', KYC_WEBHOOK_SECRET).update(rawBody, 'utf8').digest('hex');

export function postKycWebhook(
  { app }: WalletE2e,
  event: { referenceId: string; status: string; tier?: string },
  options: { signature?: string; raw?: string } = {},
) {
  const rawBody = options.raw ?? JSON.stringify({ ...event, nonce: randomUUID() });
  return app.app.request('/compliance/kyc/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-kyc-signature': options.signature ?? signKycBody(rawBody),
    },
    body: rawBody,
  });
}

export async function newKycPlayer(e2e: WalletE2e) {
  return newPlayer(e2e.app, 'kyc');
}

export const staffClient = async (e2e: WalletE2e, roleKey: string) =>
  (await newStaff(e2e.app, `kyc-${roleKey}`, roleKey)).client;

export async function playerKycStatus(e2e: WalletE2e, userId: string) {
  const [row] = await e2e.app.container
    .get(DRIZZLE)
    .db.select({ kycStatus: player.kycStatus })
    .from(player)
    .where(eq(player.userId, userId));
  return row?.kycStatus;
}

export const verificationRows = (e2e: WalletE2e, userId: string) =>
  e2e.app.container
    .get(DRIZZLE)
    .db.select()
    .from(kycVerification)
    .where(eq(kycVerification.userId, userId))
    .orderBy(desc(kycVerification.createdAt));

export const rowsForReference = (e2e: WalletE2e, referenceId: string) =>
  e2e.app.container
    .get(DRIZZLE)
    .db.select()
    .from(kycVerification)
    .where(eq(kycVerification.referenceId, referenceId));

export const waitForPlayerStatus = (e2e: WalletE2e, userId: string, status: string) =>
  vi.waitFor(
    async () => {
      const current = await playerKycStatus(e2e, userId);
      if (current !== status) {
        throw new Error(`player kyc status is ${current}, waiting for ${status}`);
      }
      return current;
    },
    { timeout: 15_000, interval: 100 },
  );

export async function settleDecisionQueue(e2e: WalletE2e) {
  const control = await newKycPlayer(e2e);
  const { referenceId } = await submitKycOrThrow(control.client);
  await postKycWebhook(e2e, { referenceId, status: 'approved' });
  await waitForPlayerStatus(e2e, control.userId, 'approved');
  await delay(1_500);
}

export const adminKycView = async (admin: TestClient, userId: string) => {
  const res = await admin.get(`/compliance/players/${userId}/kyc`);
  if (res.status !== 200) {
    throw new Error(`admin kyc view failed (${res.status}): ${await res.text()}`);
  }
  return PlayerKycViewSchema.parse(await res.json());
};

export async function registerFromCountry(e2e: WalletE2e, ip: string) {
  const email = `kyc-geo-${randomUUID()}@e2e.test`;
  const res = await e2e.app.app.request('/identity/register', {
    method: 'POST',
    headers: { ...registrationRequestHeaders(), 'x-real-ip': ip },
    body: JSON.stringify({
      email,
      password: 'password1234',
      username: `geo_${Math.floor(Math.random() * 1e11)}`,
      acceptedTerms: true,
      acceptedAge: true,
    }),
  });
  if (!res.ok) {
    throw new Error(`geo register failed (${res.status}): ${await res.text()}`);
  }
  await verifyEmailByOtp(e2e.app, email);
  const client = await asPlayer(e2e.app.app, { email });
  const profile = await client.get('/profile');
  const { id: playerId } = z.object({ id: z.string() }).parse(await profile.json());
  const [row] = await e2e.app.container
    .get(DRIZZLE)
    .db.select({ userId: player.userId })
    .from(player)
    .where(eq(player.id, playerId));
  if (!row) {
    throw new Error('geo player was not materialised');
  }
  return { client, userId: row.userId, playerId };
}

const GlobalKycSchema = z.object({
  enabled: z.boolean(),
  withdrawalThreshold: z.string().nullable(),
  cumulativeDepositThreshold: z.string(),
  updatedAt: z.string().nullable(),
});

export async function readGlobalKyc(admin: TestClient) {
  return GlobalKycSchema.parse(await (await admin.get('/compliance/global-kyc')).json());
}

export async function putGlobalKyc(
  admin: TestClient,
  patch: {
    enabled: boolean;
    withdrawalThreshold?: string | null;
    cumulativeDepositThreshold?: string;
  },
  expectedUpdatedAt: string | null,
) {
  return admin.put('/compliance/global-kyc', { ...patch, confirm: true, expectedUpdatedAt });
}

export async function withGlobalKyc(
  admin: TestClient,
  patch: {
    enabled?: boolean;
    withdrawalThreshold?: string | null;
    cumulativeDepositThreshold?: string;
  },
  run: () => Promise<void>,
) {
  const before = await readGlobalKyc(admin);
  const applied = await putGlobalKyc(
    admin,
    { enabled: before.enabled, ...patch },
    before.updatedAt,
  );
  if (applied.status !== 200) {
    throw new Error(`set global kyc failed (${applied.status}): ${await applied.text()}`);
  }
  try {
    await run();
  } finally {
    const current = await readGlobalKyc(admin);
    const restored = await putGlobalKyc(
      admin,
      {
        enabled: before.enabled,
        withdrawalThreshold: before.withdrawalThreshold,
        cumulativeDepositThreshold: before.cumulativeDepositThreshold,
      },
      current.updatedAt,
    );
    expect(restored.status).toBe(200);
  }
}

export async function openKycStream(client: TestClient) {
  const controller = new AbortController();
  const res = await client.request('/compliance/kyc/stream', {
    method: 'GET',
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
  });
  if (res.status !== 200 || !res.body) {
    controller.abort();
    throw new Error(`kyc stream failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const statuses: string[] = [];
  const pump = async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const data = frame
          .split('\n')
          .find((line) => line.startsWith('data:'))
          ?.slice('data:'.length)
          .trim();
        if (data) {
          const parsed = KycStatusUpdateSchema.safeParse(JSON.parse(data) as unknown);
          if (parsed.success) {
            statuses.push(parsed.data.status);
          }
        }
      }
    }
  };
  const pumping = pump().catch(() => undefined);
  await delay(500);
  return {
    statuses,
    waitFor: (status: string) =>
      vi.waitFor(
        () => {
          if (!statuses.includes(status)) {
            throw new Error(`stream saw [${statuses.join(',')}], waiting for ${status}`);
          }
        },
        { timeout: 15_000, interval: 100 },
      ),
    close: async () => {
      controller.abort();
      await pumping;
    },
  };
}

export async function depositExtraCurrency(
  e2e: WalletE2e,
  account: { client: TestClient },
  { amount, rated }: { amount: string; rated: boolean },
) {
  const currency = Array.from(randomBytes(8), (byte) => String.fromCharCode(65 + (byte % 26))).join(
    '',
  );
  await addAsset(e2e.admin, currency, NETWORK, '1');
  if (rated) {
    await e2e.app.container.get(DRIZZLE).db.insert(exchangeRateQuote).values({
      baseCurrency: currency,
      quoteCurrency: 'USD',
      rate: RATE,
      providerAsOf: new Date(),
    });
  }
  const address = await requestDepositAddress(account.client, currency, NETWORK);
  const res = await deliverWebhook(e2e, {
    kind: 'deposit',
    address,
    network: NETWORK,
    amount,
    currency,
    txHash: `hash-${randomUUID()}`,
    externalId: randomUUID(),
  });
  if (res.status !== 200) {
    throw new Error(`extra deposit failed (${res.status}): ${await res.text()}`);
  }
  return currency;
}

const CountryRulesSchema = z.array(
  z.object({
    countryCode: z.string(),
    kycRequired: z.boolean(),
    updatedAt: z.string().nullable(),
  }),
);

export async function countryRuleOf(admin: TestClient, countryCode: string) {
  const rules = CountryRulesSchema.parse(
    await (await admin.get('/compliance/country-rules')).json(),
  );
  return rules.find((rule) => rule.countryCode === countryCode);
}

export async function putCountryKyc(admin: TestClient, countryCode: string, kycRequired: boolean) {
  const existing = await countryRuleOf(admin, countryCode);
  return admin.put('/compliance/country-rules', {
    countryCode,
    blacklisted: false,
    redirectIp: false,
    kycRequired,
    expectedUpdatedAt: existing?.updatedAt ?? null,
    confirm: true,
  });
}

export async function withCountryKyc(
  admin: TestClient,
  countryCode: string,
  kycRequired: boolean,
  run: () => Promise<void>,
) {
  const applied = await putCountryKyc(admin, countryCode, kycRequired);
  if (applied.status !== 200) {
    throw new Error(`country rule failed (${applied.status}): ${await applied.text()}`);
  }
  try {
    await run();
  } finally {
    await putCountryKyc(admin, countryCode, true);
  }
}

export async function walletTransactionCount(e2e: WalletE2e, userId: string) {
  const rows = await e2e.app.container
    .get(DRIZZLE)
    .db.select({ id: walletTransaction.id })
    .from(walletTransaction)
    .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
    .where(eq(wallet.userId, userId));
  return rows.length;
}
