import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import {
  definePlatformConfig,
  type CustodyBalance,
  type PaymentAdapter,
} from '@openora/core/contracts';
import { makeAuditWriter, makePaymentProviderRegistry, mock } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import {
  wallet,
  walletAsset,
  walletBalance,
  walletCustodySweep,
  walletJobRun,
  walletReconciliationFinding,
  walletTransaction,
} from '../schema/index.js';
import { CustodySweepService, CUSTODY_SWEEP_JOB_NAME } from '../service/custody-sweep.service.js';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${walletReconciliationFinding}, ${walletCustodySweep}, ${walletJobRun}, ${walletAsset}, ${walletTransaction}, ${walletBalance}, ${wallet} RESTART IDENTITY CASCADE`,
  );
});

const platformConfig = (overrides: Partial<Record<string, unknown>> = {}) =>
  definePlatformConfig({
    wallet: {
      sweep: {
        cron: '*/15 * * * *',
        feeMultiple: '1',
        batchSize: 200,
        concurrency: 4,
        unknownAfterMinutes: 60,
        staleRunAfterMinutes: 30,
        ...overrides,
      },
    },
  });

async function seedAsset(overrides: Partial<typeof walletAsset.$inferInsert> = {}) {
  await db.drizzle.db.insert(walletAsset).values({
    currency: 'USDT',
    network: 'TRC20',
    providerAssetId: 'usdt-trc20',
    minDeposit: '1',
    minWithdrawal: '1',
    withdrawalFee: '0.1',
    ...overrides,
  });
}

function makeBalance(overrides: Partial<CustodyBalance> = {}): CustodyBalance {
  return {
    userId: randomUUID(),
    currency: 'USDT',
    network: 'TRC20',
    amount: '100',
    estimatedFee: '1',
    ...overrides,
  };
}

function serviceWith(adapter: PaymentAdapter, config = platformConfig()) {
  const paymentProviders = makePaymentProviderRegistry({ adapter });
  const audit = makeAuditWriter();
  const service = new CustodySweepService({
    drizzle: db.drizzle,
    paymentProviders,
    audit,
    platformConfig: config,
  });
  return { service, audit };
}

async function sweepRows(userId: string) {
  return db.drizzle.db
    .select()
    .from(walletCustodySweep)
    .where(eq(walletCustodySweep.userId, userId));
}

describe('CustodySweepService (real PG)', () => {
  it('no-ops without touching the database when sweep policy is unconfigured', async () => {
    const listSweepableBalances = vi.fn().mockResolvedValue([makeBalance()]);
    const { service } = serviceWith(
      mock<PaymentAdapter>({ listSweepableBalances, sweepToPool: vi.fn() }),
      definePlatformConfig({}),
    );

    const result = await service.runCycle();

    expect(result).toBeNull();
    expect(listSweepableBalances).not.toHaveBeenCalled();
    const runs = await db.drizzle.db.select().from(walletJobRun);
    expect(runs).toHaveLength(0);
  });

  it('a second cycle does not re-sweep an in-flight balance', async () => {
    await seedAsset();
    const b = makeBalance();
    const listSweepableBalances = vi.fn().mockResolvedValue([b]);
    const sweepToPool = vi
      .fn()
      .mockResolvedValue({ externalId: 'vendor-ref-1', poolRef: 'pool-players-1' });
    const { service } = serviceWith(mock<PaymentAdapter>({ listSweepableBalances, sweepToPool }));

    const first = await service.runCycle();
    expect(first?.summary.swept).toBe(1);

    const second = await service.runCycle();
    expect(second?.summary.swept).toBe(0);
    expect(second?.summary.inFlight).toBe(1);

    expect(sweepToPool).toHaveBeenCalledTimes(1);
    const rows = await sweepRows(b.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('processing');
    // Which pool received the funds, not merely that a transfer happened - the
    // separation of player money from operator money has to be evidenced.
    expect(rows[0]?.poolRef).toBe('pool-players-1');
  });

  it('sweepToPool throws -> the guard is still held and the next cycle does not re-sweep', async () => {
    await seedAsset();
    const b = makeBalance();
    const listSweepableBalances = vi.fn().mockResolvedValue([b]);
    const sweepToPool = vi.fn().mockRejectedValue(new Error('vendor timed out'));
    const { service } = serviceWith(mock<PaymentAdapter>({ listSweepableBalances, sweepToPool }));

    const first = await service.runCycle();
    expect(first?.summary.unknown).toBe(1);
    expect(first?.summary.swept).toBe(0);

    const rowsAfterFirst = await sweepRows(b.userId);
    expect(rowsAfterFirst).toHaveLength(1);
    expect(rowsAfterFirst[0]?.status).toBe('unknown');

    const second = await service.runCycle();
    expect(second?.summary.inFlight).toBe(1);
    expect(second?.summary.swept).toBe(0);

    // Still exactly the one row from the first cycle - the throw never released the guard.
    expect(sweepToPool).toHaveBeenCalledTimes(1);
    const rowsAfterSecond = await sweepRows(b.userId);
    expect(rowsAfterSecond).toHaveLength(1);
    expect(rowsAfterSecond[0]?.status).toBe('unknown');
  });

  it('a swept balance changes no wallet_balance row and creates no wallet_transaction', async () => {
    await seedAsset();
    const b = makeBalance();
    const adapter = mock<PaymentAdapter>({
      listSweepableBalances: vi.fn().mockResolvedValue([b]),
      sweepToPool: vi.fn().mockResolvedValue({ externalId: 'vendor-ref-2' }),
    });
    const { service } = serviceWith(adapter);

    const result = await service.runCycle();
    expect(result?.summary.swept).toBe(1);

    const balances = await db.drizzle.db.select().from(walletBalance);
    const transactions = await db.drizzle.db.select().from(walletTransaction);
    expect(balances).toHaveLength(0);
    expect(transactions).toHaveLength(0);
  });

  it('two cycles started concurrently: the second returns immediately and listSweepableBalances is called exactly once', async () => {
    await seedAsset();
    const listSweepableBalances = vi.fn().mockResolvedValue([makeBalance()]);
    const sweepToPool = vi.fn().mockResolvedValue({ externalId: randomUUID() });
    const { service } = serviceWith(mock<PaymentAdapter>({ listSweepableBalances, sweepToPool }));

    const [a, b] = await Promise.all([service.runCycle(), service.runCycle()]);
    const results = [a, b];
    const claimed = results.filter((r) => r !== null);
    const skipped = results.filter((r) => r === null);

    expect(claimed).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect(listSweepableBalances).toHaveBeenCalledTimes(1);
  });

  it('a missing wallet_asset row produces an unconfigured_asset finding', async () => {
    // Deliberately no seedAsset() call - (currency, network) is unconfigured.
    const b = makeBalance({ currency: 'DOGE', network: 'MAINNET' });
    const listSweepableBalances = vi.fn().mockResolvedValue([b]);
    const sweepToPool = vi.fn().mockResolvedValue({ externalId: 'never-called' });
    const { service } = serviceWith(mock<PaymentAdapter>({ listSweepableBalances, sweepToPool }));

    const result = await service.runCycle();
    expect(result?.summary.swept).toBe(0);
    expect(result?.summary.skippedDust).toBe(0);

    const findings = await db.drizzle.db.select().from(walletReconciliationFinding);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'unconfigured_asset',
      currency: 'DOGE',
      network: 'MAINNET',
      amount: '100.000000000000000000',
      runId: result?.runId,
    });

    const sweeps = await sweepRows(b.userId);
    expect(sweeps).toHaveLength(0);
  });

  it('writes exactly one audit entry per cycle regardless of how many balances were swept', async () => {
    await seedAsset();
    const balances = [makeBalance(), makeBalance(), makeBalance()];
    const adapter = mock<PaymentAdapter>({
      listSweepableBalances: vi.fn().mockResolvedValue(balances),
      sweepToPool: vi.fn().mockImplementation(async () => ({ externalId: randomUUID() })),
    });
    const { service, audit } = serviceWith(adapter);

    const result = await service.runCycle();
    expect(result?.summary.swept).toBe(3);

    expect(audit.recordInTransaction).toHaveBeenCalledTimes(1);
    const [, entry] = (audit.recordInTransaction as ReturnType<typeof vi.fn>).mock.calls[0] as [
      unknown,
      { action: string; after: Record<string, unknown> },
    ];
    expect(entry.action).toBe('wallet.custody.sweep_cycle');
    expect(entry.after).toMatchObject({ runId: result?.runId, swept: 3 });
  });

  it('a repeated unconfigured asset files exactly one finding, not one per cycle', async () => {
    // Without a stable dedup key this condition - which recurs every single tick until
    // an operator configures the asset - files a fresh finding per cron tick and pins
    // the reconciliation alert threshold permanently over the line.
    const b = makeBalance({ currency: 'DOGE', network: 'MAINNET' });
    const listSweepableBalances = vi.fn().mockResolvedValue([b]);
    const sweepToPool = vi.fn();
    const { service } = serviceWith(mock<PaymentAdapter>({ listSweepableBalances, sweepToPool }));

    await service.runCycle();
    await service.runCycle();

    const findings = await db.drizzle.db.select().from(walletReconciliationFinding);
    expect(findings).toHaveLength(1);
  });

  it('a throwing adapter fails the run and frees the claim for the next cycle', async () => {
    await seedAsset();
    const listSweepableBalances = vi
      .fn()
      .mockRejectedValueOnce(new Error('vendor 503'))
      .mockResolvedValue([]);
    const { service } = serviceWith(
      mock<PaymentAdapter>({ listSweepableBalances, sweepToPool: vi.fn() }),
    );

    await expect(service.runCycle()).rejects.toThrow('vendor 503');

    const [failed] = await db.drizzle.db
      .select()
      .from(walletJobRun)
      .where(eq(walletJobRun.status, 'failed'));
    expect(failed?.finishedAt).not.toBeNull();

    // The whole point: a vendor blip must not hold the single live-run slot until the
    // staleness window elapses.
    const second = await service.runCycle();
    expect(second).not.toBeNull();
  });

  it('takes over a run whose startedAt is older than the staleness threshold', async () => {
    const staleRunId = randomUUID();
    await db.drizzle.db.insert(walletJobRun).values({
      jobName: CUSTODY_SWEEP_JOB_NAME,
      runId: staleRunId,
      startedAt: new Date(Date.now() - 2 * 60_000),
    });
    const listSweepableBalances = vi.fn().mockResolvedValue([]);
    const { service } = serviceWith(
      mock<PaymentAdapter>({ listSweepableBalances, sweepToPool: vi.fn() }),
      platformConfig({ staleRunAfterMinutes: 1 }),
    );

    const result = await service.runCycle();

    expect(result).not.toBeNull();
    expect(result?.runId).not.toBe(staleRunId);
    const runs = await db.drizzle.db
      .select()
      .from(walletJobRun)
      .where(eq(walletJobRun.jobName, CUSTODY_SWEEP_JOB_NAME));
    const stale = runs.find((r) => r.runId === staleRunId);
    const fresh = runs.find((r) => r.runId === result?.runId);
    expect(stale?.status).toBe('abandoned');
    expect(fresh?.status).toBe('completed');
  });
});
