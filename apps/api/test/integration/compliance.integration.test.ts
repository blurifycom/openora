import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, type IntegrationHarness } from './harness.js';

describe('compliance (integration)', () => {
  let h: IntegrationHarness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h?.stop();
  });

  it('GET /compliance/geo-check allows by default (no GeoIpAdapter bound)', async () => {
    const res = await h.asPlayer().get('/compliance/geo-check');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { allowed: boolean };
    expect(body.allowed).toBe(true);
  });

  it('PUT /compliance/limits upserts a limit, then GET reads it back', async () => {
    const client = h.asPlayer();
    const upsert = await client.put('/compliance/limits', {
      type: 'deposit',
      period: 'daily',
      amount: 500,
    });
    expect(upsert.status).toBe(200);
    const created = (await upsert.json()) as { type: string; period: string; amount: number };
    expect(created.type).toBe('deposit');
    expect(created.amount).toBe(500);

    const list = await client.get('/compliance/limits');
    expect(list.status).toBe(200);
    const limits = (await list.json()) as Array<{ type: string; period: string }>;
    expect(limits.some((l) => l.type === 'deposit' && l.period === 'daily')).toBe(true);
  });
});
