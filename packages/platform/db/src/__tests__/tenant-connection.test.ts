import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { getRequestDb, runWithTenantConnection } from '../tenant-connection.js';

// Fake PoolClient that records the SQL run on it and whether it was released.
// drizzle(client) calls client.query(...) under the hood for db.execute(); we only
// need to capture the GUC set/reset calls and the release lifecycle.
function makeFakeClient(opts: { failReset?: boolean } = {}) {
  const calls: string[] = [];
  let released: 'clean' | 'destroyed' | undefined;
  const client = {
    query: vi.fn(async (config: unknown) => {
      // drizzle passes a query object { text, values } to node-postgres clients.
      const text =
        typeof config === 'string'
          ? config
          : ((config as { text?: string }).text ?? JSON.stringify(config));
      calls.push(text);
      if (opts.failReset && /set_config\('app\.tenant_id', ''/.test(text)) {
        throw new Error('connection broken');
      }
      return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] };
    }),
    release: vi.fn((destroy?: boolean) => {
      released = destroy ? 'destroyed' : 'clean';
    }),
  };
  return {
    client: client as unknown as PoolClient,
    calls,
    get released() {
      return released;
    },
  };
}

describe('runWithTenantConnection', () => {
  it('sets the tenant GUC, runs fn with a pinned db, then resets and releases', async () => {
    const fake = makeFakeClient();

    let storeTenantInside: string | undefined;
    const result = await runWithTenantConnection(
      async () => fake.client,
      'tenant-a',
      async () => {
        storeTenantInside = getRequestDb()?.tenantId;
        return 'ok';
      },
    );

    expect(result).toBe('ok');
    expect(storeTenantInside).toBe('tenant-a');

    // First call sets the GUC to the tenant, last call resets it to empty.
    const setCall = fake.calls.find((c) => c.includes("set_config('app.tenant_id'"));
    expect(setCall).toBeDefined();
    const resetCall = fake.calls.find((c) => /set_config\('app\.tenant_id', ''/.test(c));
    expect(resetCall).toBeDefined();
    // Clean release - the client re-enters the pool with no residual GUC.
    expect(fake.released).toBe('clean');
  });

  it('resets and releases the client even when fn throws (no residual GUC)', async () => {
    const fake = makeFakeClient();

    await expect(
      runWithTenantConnection(
        async () => fake.client,
        'tenant-b',
        async () => {
          throw new Error('boom');
        },
      ),
    ).rejects.toThrow('boom');

    // The GUC was reset before release despite the throw.
    expect(fake.calls.some((c) => /set_config\('app\.tenant_id', ''/.test(c))).toBe(true);
    expect(fake.released).toBe('clean');
  });

  it('destroys the client (release(true)) if the reset itself fails - fail-closed', async () => {
    const fake = makeFakeClient({ failReset: true });

    const result = await runWithTenantConnection(
      async () => fake.client,
      'tenant-c',
      async () => 'value',
    );

    expect(result).toBe('value');
    // A connection whose GUC could not be cleared must never re-enter the pool.
    expect(fake.released).toBe('destroyed');
  });

  it('leaves no request db in the store after completion', async () => {
    const fake = makeFakeClient();
    await runWithTenantConnection(
      async () => fake.client,
      'tenant-d',
      async () => undefined,
    );
    expect(getRequestDb()).toBeUndefined();
  });

  it('isolates concurrent tenants - each fn sees only its own pinned tenant', async () => {
    const results: Record<string, string | undefined> = {};
    await Promise.all(
      ['t1', 't2', 't3'].map((t) =>
        runWithTenantConnection(
          async () => makeFakeClient().client,
          t,
          async () => {
            // Yield so the runs interleave; the AsyncLocalStorage must keep them apart.
            await new Promise((r) => setTimeout(r, 1));
            results[t] = getRequestDb()?.tenantId;
          },
        ),
      ),
    );
    expect(results).toEqual({ t1: 't1', t2: 't2', t3: 't3' });
  });
});
