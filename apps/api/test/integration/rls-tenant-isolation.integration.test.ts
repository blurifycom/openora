import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DrizzleService, getRequestDb } from '@oss/db';
import { orm } from '@oss/db';
import { wallet } from '@oss-addons/wallet/schema';
import { WalletService } from '@oss-addons/wallet';
import { withTenant, createEventBus, InMemoryBroker, createLogger } from '@oss/core';
import type { PaymentAdapter } from '@oss/adapters';
import { setupTestDb, type TestDb } from '@oss/testing';

const { eq } = orm;

// Minimal PSP fake - the deposit ledger write is what we exercise, not the PSP.
const fakePayment: PaymentAdapter = {
  async processDeposit() {
    return { externalId: 'fake-deposit', status: 'completed' };
  },
  async processWithdrawal() {
    return { externalId: 'fake-withdrawal', status: 'completed' };
  },
};

// Proves Postgres RLS tenant isolation end to end against a real database, through
// the SAME code path the app uses: DrizzleService.runWithTenant pins a connection,
// sets app.tenant_id on it, and the this.db facade routes queries to it (ADR-0018).
// FORCE ROW LEVEL SECURITY makes the policy apply even to the table owner, so this
// holds in the single-superuser CI/local setup.
describe('RLS tenant isolation (integration)', () => {
  let testDb: TestDb;
  let svc: DrizzleService;

  const TENANT_A = 'rls-tenant-a';
  const TENANT_B = 'rls-tenant-b';

  beforeAll(async () => {
    testDb = await setupTestDb();
    await testDb.truncateAll();
    // RLS only bites for a NON-superuser, NON-BYPASSRLS role. The local/CI test DB
    // owner is usually a superuser (which always bypasses RLS, even with FORCE), so
    // we connect the app pool as `oss_app` - the RLS-enforced role the migration
    // creates - to prove the policy genuinely isolates tenants (ADR-0018).
    const appUrl = new URL(testDb.url);
    appUrl.username = 'oss_app';
    appUrl.password = 'oss_app_dev';
    process.env['DATABASE_URL'] = appUrl.toString();
    // adminDb stays on the (super)owner connection - the BYPASSRLS / system path.
    process.env['DATABASE_ADMIN_URL'] = testDb.url;
    svc = new DrizzleService();
  });

  afterAll(async () => {
    await svc?.dispose();
    await testDb?.dispose();
  });

  async function insertWallet(tenantId: string, userId: string): Promise<void> {
    await svc.runWithTenant(tenantId, async () => {
      await svc.db.insert(wallet).values({ userId, tenantId, balance: '100', currency: 'USD' });
    });
  }

  async function userIdsSeenBy(tenantId: string): Promise<string[]> {
    return svc.runWithTenant(tenantId, async () => {
      const rows = await svc.db.select({ userId: wallet.userId }).from(wallet);
      return rows.map((r) => r.userId);
    });
  }

  it("tenant A's connection cannot read tenant B's rows", async () => {
    await insertWallet(TENANT_A, 'user-a');
    await insertWallet(TENANT_B, 'user-b');

    const seenByA = await userIdsSeenBy(TENANT_A);
    const seenByB = await userIdsSeenBy(TENANT_B);

    expect(seenByA).toContain('user-a');
    expect(seenByA).not.toContain('user-b');
    expect(seenByB).toContain('user-b');
    expect(seenByB).not.toContain('user-a');
  });

  it('the admin (BYPASSRLS) db sees every tenant', async () => {
    // In the single-role test setup adminDb falls back to the same role, but it
    // never sets a tenant GUC, so it is NOT scoped by runWithTenant. It should see
    // both tenants' rows.
    const all = await svc.adminDb.select({ tenantId: wallet.tenantId }).from(wallet);
    const tenants = new Set(all.map((r) => r.tenantId));
    expect(tenants.has(TENANT_A)).toBe(true);
    expect(tenants.has(TENANT_B)).toBe(true);
  });

  it('the WITH CHECK clause rejects writing a row for another tenant', async () => {
    await expect(
      svc.runWithTenant(TENANT_A, async () => {
        await svc.db
          .insert(wallet)
          .values({ userId: 'smuggled', tenantId: TENANT_B, balance: '999', currency: 'USD' });
      }),
    ).rejects.toThrow();
  });

  it('runWithTenant cannot delete another tenant rows', async () => {
    await svc.runWithTenant(TENANT_A, async () => {
      await svc.db.delete(wallet).where(eq(wallet.userId, 'user-b'));
    });
    // user-b still exists - the delete matched zero rows under tenant A's policy.
    const seenByB = await userIdsSeenBy(TENANT_B);
    expect(seenByB).toContain('user-b');
  });

  it('clears the request db store after the scope ends (no residual binding)', async () => {
    await svc.runWithTenant(TENANT_A, async () => {
      expect(getRequestDb()?.tenantId).toBe(TENANT_A);
    });
    expect(getRequestDb()).toBeUndefined();
  });

  // C2 regression: drive the REAL WalletService through the enforced app role,
  // exactly as a request does (withTenant + runWithTenant). The first deposit
  // creates the wallet row, which must be stamped with the request tenant - the
  // old hard-coded `tenantId: ''` was rejected by the WITH CHECK policy here. A
  // hand-inserted row with a correct tenantId would NOT have caught that bug; this
  // exercises the service insert path.
  it('first deposit through WalletService creates a wallet under the request tenant', async () => {
    const events = createEventBus(new InMemoryBroker(), createLogger('test'));
    const service = new WalletService(svc, events, fakePayment);
    const userId = 'rls-deposit-user';

    await withTenant({ userId, tenantId: TENANT_A, traceId: 't' }, () =>
      svc.runWithTenant(TENANT_A, async () => {
        const result = await service.deposit(userId, 50, 'USD');
        expect(result.status).toBe('completed');
        const balance = await service.getBalance(userId);
        expect(balance.balance).toBe(50);
        expect(balance.tenantId).toBe(TENANT_A);
      }),
    );

    // The created wallet carries tenant A and is invisible to tenant B (RLS).
    const seenByB = await userIdsSeenBy(TENANT_B);
    expect(seenByB).not.toContain(userId);
    const seenByA = await userIdsSeenBy(TENANT_A);
    expect(seenByA).toContain(userId);
  });
});
