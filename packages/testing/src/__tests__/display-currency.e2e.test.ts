import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { loadExtensions, DRIZZLE } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import {
  setupTestDb,
  bootTestApp,
  registerAndMaterializePlayer,
  seedMinimal,
  type TestDb,
  type TestApp,
  type TestClient,
} from '../index.js';

let db: TestDb;
let app: TestApp;
let player: TestClient;
let playerId: string;

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  app = await bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url });
  await seedMinimal(app.container, { playerCount: 0 });
  ({ client: player, playerId } = await registerAndMaterializePlayer(app, {
    email: `display-currency-${randomUUID()}@e2e.test`,
  }));
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.dispose();
});

describe('GET /profile/display-currency', () => {
  it('falls back to the wallet active currency for a player who never chose one', async () => {
    const res = await player.get('/profile/display-currency');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { currency: string; supported: string[] };
    // No wallet balances exist yet, so resolution floors out at the wallet's
    // own operating currency - never throws, never calls a rate vendor.
    expect(typeof body.currency).toBe('string');
    expect(body.supported).toContain('USD');
    expect(body.supported).toContain('BTC');
  });
});

describe('PUT /profile/display-currency', () => {
  it('persists the pick, records an audit entry, and reflects it on the next read', async () => {
    const res = await player.put('/profile/display-currency', { currency: 'eur' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { currency: string; supported: string[] };
    expect(body.currency).toBe('EUR');

    const readBack = await player.get('/profile/display-currency');
    expect((await readBack.json()) as { currency: string }).toMatchObject({ currency: 'EUR' });

    const rows = await app.container
      .get(DRIZZLE)
      .db.select()
      .from(auditLog)
      .where(
        and(eq(auditLog.resourceId, playerId), eq(auditLog.action, 'player.display_currency.set')),
      );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('rejects a currency outside the operator-supported list instead of writing it', async () => {
    const res = await player.put('/profile/display-currency', { currency: 'ZZZ' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    const after = await player.get('/profile/display-currency');
    expect((await after.json()) as { currency: string }).not.toMatchObject({ currency: 'ZZZ' });
  });
});

describe('GET /exchange-rate/rates', () => {
  it('returns one entry per source currency, null quote when no rate is available', async () => {
    const res = await player.get('/exchange-rate/rates?to=USD&from[]=USD&from[]=BTC');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { from: string; quote: unknown }[];
    expect(body).toHaveLength(2);
    const byFrom = Object.fromEntries(body.map((entry) => [entry.from, entry.quote]));
    expect(byFrom['USD']).toMatchObject({ rate: '1.000000000000000000' });
    expect(byFrom['BTC']).toBeNull();
  });

  it('rejects a malformed target currency with a validation error instead of 200', async () => {
    const res = await player.get('/exchange-rate/rates?to=$$$&from[]=USD');

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
