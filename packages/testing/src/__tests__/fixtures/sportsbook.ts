import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import {
  SPORTSBOOK_LEDGER,
  type SportsbookLedger,
  type SportsbookLedgerOutcome,
  type SportsbookReserveArgs,
} from '@openora/core/contracts';
import { wallet, walletBalance } from '@openora/core/wallet/schema';
import {
  asAdmin,
  bootE2e,
  registerAndMaterializePlayer,
  type E2e,
  type TestApp,
  type TestClient,
} from '../../index.js';
import { mockSportsbookProvider } from '../../test-sportsbook-provider-plugin.js';

export const PROVIDER = mockSportsbookProvider.name;
export const PLAYER_IP = '203.0.113.20';

const pluginPath = (file: string) => fileURLToPath(new URL(`../../${file}`, import.meta.url));

export async function bootSportsbookApp({
  provider = 'scripted',
  without = [],
}: { provider?: 'scripted' | 'without-status'; without?: readonly string[] } = {}): Promise<E2e> {
  return bootE2e({
    plugins: [
      ...(await loadExtensions((entries) => entries.filter((e) => !without.includes(e.id)))),
      { id: 'testing-geo-ip', path: pluginPath('test-geo-ip-plugin.ts') },
      {
        id: 'testing-exchange-rate-provider',
        path: pluginPath('test-exchange-rate-provider-plugin.ts'),
      },
      provider === 'scripted'
        ? {
            id: 'testing-sportsbook-provider',
            path: pluginPath('test-sportsbook-provider-plugin.ts'),
          }
        : {
            id: 'testing-sportsbook-provider-without-status',
            path: pluginPath('test-sportsbook-provider-without-status-plugin.ts'),
          },
    ],
  });
}

export const ledgerOf = (app: TestApp): SportsbookLedger => app.container.get(SPORTSBOOK_LEDGER);

export async function enableSportsbook(
  app: TestApp,
  overrides: Record<string, unknown> = {},
  signedIn?: TestClient,
): Promise<TestClient> {
  const admin = signedIn ?? (await asAdmin(app.app));
  const res = await admin.put('/backoffice/sportsbook/config', {
    enabled: true,
    currencies: [
      { currency: 'USD', decimals: 2 },
      { currency: 'EUR', decimals: 2 },
    ],
    blockedCountries: [],
    reserveTimeoutSeconds: 30,
    settlementGraceMinutes: 10,
    sessionTtlMinutes: 60,
    ...overrides,
  });
  if (res.status !== 200) {
    throw new Error(`sportsbook config failed (${res.status}): ${await res.text()}`);
  }
  return admin;
}

export async function deposit(client: TestClient, amount: string, currency = 'USD') {
  const res = await client.post('/wallet/deposit', {
    idempotencyKey: randomUUID(),
    amount,
    currency,
  });
  if (res.status !== 200) {
    throw new Error(`deposit failed (${res.status}): ${await res.text()}`);
  }
}

export async function openSession(client: TestClient, currency = 'USD', locale?: string) {
  return client.request('/sportsbook/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': PLAYER_IP },
    body: JSON.stringify({ currency, locale }),
  });
}

export type SportsbookPlayer = {
  client: TestClient;
  userId: string;
  sessionId: string;
};

export async function fundedPlayer(
  app: TestApp,
  amount = '100',
  currency = 'USD',
): Promise<SportsbookPlayer> {
  const { client, userId } = await registerAndMaterializePlayer(app, {
    email: `sportsbook-${randomUUID()}@example.com`,
  });
  if (amount !== '0') {
    await deposit(client, amount, currency);
  }
  const res = await openSession(client, currency);
  if (res.status !== 200) {
    throw new Error(`session issue failed (${res.status}): ${await res.text()}`);
  }
  const { sessionId } = (await res.json()) as { sessionId: string };
  return { client, userId, sessionId };
}

export function reserveArgs(
  sessionId: string,
  overrides: Partial<SportsbookReserveArgs> = {},
): SportsbookReserveArgs {
  const startsAt = new Date(Date.now() + 3_600_000).toISOString();
  return {
    provider: PROVIDER,
    providerTxId: `tx-${randomUUID()}`,
    providerBetId: `bet-${randomUUID()}`,
    sessionId,
    currency: 'USD',
    stake: '10',
    potentialPayout: '25',
    legs: [{ eventId: 'event-1', startsAt }],
    ...overrides,
  };
}

export const txId = () => `tx-${randomUUID()}`;

export function expectApplied(outcome: SportsbookLedgerOutcome) {
  if (outcome.status === 'refused') {
    throw new Error(`expected the ledger to apply, it refused: ${outcome.reason}`);
  }
  return outcome;
}

export async function acceptedBet(
  app: TestApp,
  player: SportsbookPlayer,
  overrides: Partial<SportsbookReserveArgs> = {},
) {
  const ledger = ledgerOf(app);
  const args = reserveArgs(player.sessionId, overrides);
  const reserved = expectApplied(await ledger.reserve(args));
  expectApplied(
    await ledger.confirm({
      provider: PROVIDER,
      providerTxId: txId(),
      providerBetId: args.providerBetId,
    }),
  );
  return { args, betId: reserved.betId! };
}

export async function balanceOf(app: TestApp, userId: string, currency = 'USD'): Promise<string> {
  const [row] = await app.container
    .get(DRIZZLE)
    .db.select({ amount: walletBalance.amount })
    .from(walletBalance)
    .innerJoin(wallet, eq(wallet.id, walletBalance.walletId))
    .where(and(eq(wallet.userId, userId), eq(walletBalance.currency, currency)));
  return row?.amount ?? '0';
}
