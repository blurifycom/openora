import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, type IntegrationHarness } from './harness.js';

describe('wallet (integration)', () => {
  let h: IntegrationHarness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h?.stop();
  });

  it('GET /wallet/balance returns the seeded player balance', async () => {
    const res = await h.asPlayer().get('/wallet/balance');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { balance: number; currency: string };
    expect(typeof body.balance).toBe('number');
    expect(body.currency).toBeTruthy();
  });

  it('POST /wallet/deposit increases the balance by the deposited amount', async () => {
    const client = h.asPlayer();
    const before = (await (await client.get('/wallet/balance')).json()) as { balance: number };

    const dep = await client.post('/wallet/deposit', { amount: 100, currency: 'USD' });
    expect(dep.status).toBe(200);
    const result = (await dep.json()) as { transactionId: string; status: string };
    expect(result.transactionId).toBeTruthy();
    expect(result.status).toBe('completed');

    const after = (await (await client.get('/wallet/balance')).json()) as { balance: number };
    expect(after.balance - before.balance).toBeCloseTo(100, 2);
  });

  it('POST /wallet/withdraw beyond balance is rejected with a 4xx (InsufficientBalance)', async () => {
    const res = await h.asPlayer().post('/wallet/withdraw', {
      amount: 1_000_000_000,
      currency: 'USD',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('rejects an unauthenticated caller (no x-user-id)', async () => {
    const res = await h.app.request('/wallet/balance', { method: 'GET' });
    expect(res.ok).toBe(false);
  });
});
