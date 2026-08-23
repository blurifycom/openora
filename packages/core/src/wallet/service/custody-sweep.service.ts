import { randomUUID } from 'node:crypto';
import * as z from 'zod';
import {
  type DrizzleService,
  moneyCompare,
  moneyScaleBy,
  mapConcurrent,
  createLogger,
} from '@openora/core/server';
import {
  queue,
  UuidSchema,
  type AuditWritePort,
  type CustodyBalance,
  type PaymentAdapter,
  type PaymentProviderRegistry,
  type PlatformConfig,
  type User,
  type Uuid,
} from '@openora/core/contracts';
import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import {
  walletAsset,
  walletCustodySweep,
  walletJobRun,
  type WalletAssetRow,
  type WalletJobRun,
} from '../schema/index.js';
import { recordReconciliationFinding } from './reconciliation-finding.service.js';

const logger = createLogger('wallet-custody-sweep');

export const CUSTODY_SWEEP_JOB_NAME = 'wallet-custody-sweep';
export const CUSTODY_SWEEP_QUEUE = queue('wallet.custody-sweep');

// `runId` is only present when an admin's on-demand POST /wallet/custody/sweep/run
// enqueued this tick - the router mints it up front so it can hand the caller back a
// runId synchronously, before the job actually runs. A cron tick omits it and the
// service mints its own.
export const CustodySweepJobPayloadSchema = z.object({ runId: UuidSchema.optional() });
export type CustodySweepJobPayload = z.infer<typeof CustodySweepJobPayloadSchema>;

const IN_FLIGHT_STATUSES = ['pending', 'processing', 'unknown'] as const;

type SweepConfig = NonNullable<NonNullable<PlatformConfig['wallet']>['sweep']>;

export type SweepCycleSummary = {
  considered: number;
  swept: number;
  skippedDust: number;
  skippedFee: number;
  skippedCeiling: number;
  inFlight: number;
  // Always 0 today: `PaymentAdapter.sweepToPool` can only resolve or throw, so a caught
  // error has no way to prove "the vendor definitively rejected this and created no
  // transaction" - see the catch block in processBalance. The field stays in the
  // summary shape for the day an adapter can prove a definitive rejection.
  failed: number;
  unknown: number;
};

export type SweepGateDecision = 'sweep' | 'dust' | 'fee' | 'ceiling';

/**
 * Pure gate over a single custody balance, in the exact order
 * docs/adapters/payment.md diagram D3 specifies: dust floor, then the fee-multiple
 * floor, then the fee ceiling (overridden only when the pool is running dry).
 *
 * `poolBalance` is null whenever the caller hasn't fetched it (no ceiling breach yet,
 * the adapter has no `getPoolBalance`, or the asset has no `poolLiquidityFloor`) - null
 * always means "the ceiling stays absolute", never an accidental override.
 */
export function gateSweepBalance(args: {
  amount: string;
  estimatedFee: string;
  dustThreshold: string;
  feeMultiple: string;
  sweepFeeCeiling: string | null;
  poolLiquidityFloor: string | null;
  poolBalance: string | null;
}): SweepGateDecision {
  if (moneyCompare(args.amount, args.dustThreshold) < 0) {
    return 'dust';
  }
  const feeFloor = moneyScaleBy(args.estimatedFee, args.feeMultiple);
  if (moneyCompare(args.amount, feeFloor) < 0) {
    return 'fee';
  }
  if (args.sweepFeeCeiling !== null && moneyCompare(args.estimatedFee, args.sweepFeeCeiling) > 0) {
    const poolBelowFloor =
      args.poolLiquidityFloor !== null &&
      args.poolBalance !== null &&
      moneyCompare(args.poolBalance, args.poolLiquidityFloor) < 0;
    if (!poolBelowFloor) {
      return 'ceiling';
    }
  }
  return 'sweep';
}

export type CustodySweepServiceDeps = {
  drizzle: DrizzleService;
  paymentProviders: PaymentProviderRegistry;
  audit: AuditWritePort;
  platformConfig?: PlatformConfig;
};

/**
 * Owns the custody sweep cron: moves vendor-side per-player custody balances into the
 * pooled account they're paid out of. Deliberately separate from WalletService (which
 * is already ~2000 lines) and deliberately never touches wallet_balance/wallet_transaction
 * - the player was credited at deposit time, this only moves the vendor's own money
 * between its own containers. See docs/adapters/payment.md, "Custody: pooling, sweeping
 * and reconciliation".
 */
export class CustodySweepService {
  private readonly drizzle: DrizzleService;
  private readonly paymentProviders: PaymentProviderRegistry;
  private readonly audit: AuditWritePort;
  private readonly platformConfig?: PlatformConfig;

  constructor({ drizzle, paymentProviders, audit, platformConfig }: CustodySweepServiceDeps) {
    this.drizzle = drizzle;
    this.paymentProviders = paymentProviders;
    this.audit = audit;
    this.platformConfig = platformConfig;
  }

  /**
   * Runs one sweep cycle. No-ops (returns null, touches nothing) when
   * `platformConfig.wallet.sweep` is absent - an operator who hasn't configured sweep
   * policy still gets a scheduled job, it just never claims a run. Also returns null
   * when another cycle already owns the claim.
   */
  async runCycle(
    requestedRunId?: Uuid,
  ): Promise<{ runId: Uuid; summary: SweepCycleSummary } | null> {
    const sweepConfig = this.platformConfig?.wallet?.sweep;
    if (!sweepConfig) {
      return null;
    }

    const claim = await this.claimRun(requestedRunId, sweepConfig.staleRunAfterMinutes);
    if (!claim) {
      return null;
    }
    const { runId, jobRunId } = claim;

    const summary: SweepCycleSummary = {
      considered: 0,
      swept: 0,
      skippedDust: 0,
      skippedFee: 0,
      skippedCeiling: 0,
      inFlight: 0,
      failed: 0,
      unknown: 0,
    };

    // Everything past the claim runs guarded: an adapter that throws (a vendor 5xx is
    // the ordinary case) would otherwise leave this run's row with finishedAt NULL, and
    // the partial unique index would then block every subsequent cycle until the
    // staleness takeover window elapsed. A failed cycle must free its own slot.
    try {
      await this.resolveInFlightSweeps(sweepConfig.concurrency, sweepConfig.batchSize);

      const poolBalanceCache = new Map<string, string>();
      for (const providerName of this.paymentProviders.names()) {
        const adapter = this.paymentProviders.get(providerName)?.adapter;
        // sweepToPool is checked here, not after a claim row exists: an adapter that
        // advertises listSweepableBalances without it would otherwise claim a container,
        // throw, and park an `unknown` row that holds the in-flight guard forever.
        if (!adapter?.listSweepableBalances) {
          continue;
        }
        if (!adapter.sweepToPool) {
          logger.error(
            { providerName },
            'provider lists sweepable balances but cannot sweep them; skipping',
          );
          continue;
        }
        // listSweepableBalances is unbounded; sweeping is throughput work, so the cron
        // cadence drains the backlog rather than one cycle chasing it all.
        const balances = (await adapter.listSweepableBalances()).slice(0, sweepConfig.batchSize);
        summary.considered += balances.length;
        await mapConcurrent(balances, sweepConfig.concurrency, (balance) =>
          this.processBalance({
            providerName,
            adapter,
            balance,
            runId,
            sweepConfig,
            summary,
            poolBalanceCache,
          }),
        );
      }
    } catch (err) {
      await this.finishRun(jobRunId, runId, summary, 'failed', err);
      throw err;
    }

    await this.finishRun(jobRunId, runId, summary);
    return { runId, summary };
  }

  // The insert IS the claim: the partial unique index on wallet_job_run(job_name) WHERE
  // finished_at IS NULL means a conflicting insert can only mean another cycle already
  // owns it. A run whose startedAt outlives `staleAfterMinutes` is presumed crashed and
  // taken over: marked abandoned, then re-claimed inside the same transaction.
  private async claimRun(
    requestedRunId: Uuid | undefined,
    staleAfterMinutes: number,
  ): Promise<{ runId: Uuid; jobRunId: WalletJobRun['id'] } | null> {
    const runId = requestedRunId ?? randomUUID();
    return this.drizzle.db.transaction(async (txn) => {
      const [inserted] = await txn
        .insert(walletJobRun)
        .values({ jobName: CUSTODY_SWEEP_JOB_NAME, runId })
        .onConflictDoNothing()
        .returning();
      if (inserted) {
        return { runId, jobRunId: inserted.id };
      }

      const [existing] = await txn
        .select()
        .from(walletJobRun)
        .where(
          and(eq(walletJobRun.jobName, CUSTODY_SWEEP_JOB_NAME), isNull(walletJobRun.finishedAt)),
        )
        .for('update');
      if (!existing) {
        // The owning run finished between our failed insert and this read - let the
        // next tick claim cleanly instead of racing a second insert here.
        return null;
      }
      const staleMs = staleAfterMinutes * 60_000;
      if (Date.now() - existing.startedAt.getTime() < staleMs) {
        return null;
      }
      await txn
        .update(walletJobRun)
        .set({ status: 'abandoned', finishedAt: new Date() })
        .where(eq(walletJobRun.id, existing.id));
      const [takenOver] = await txn
        .insert(walletJobRun)
        .values({ jobName: CUSTODY_SWEEP_JOB_NAME, runId })
        .returning();
      if (!takenOver) {
        throw new Error('wallet-custody-sweep: failed to claim run after abandoning a stale one');
      }
      return { runId, jobRunId: takenOver.id };
    });
  }

  // Reusing getWithdrawalStatus for a sweep is deliberate: its {status, txHash} shape
  // is generic to any vendor transaction (a withdrawal or a sweep), and a sweep's
  // externalId is exactly the reference such a lookup needs.
  private async resolveInFlightSweeps(concurrency: number, batchSize: number): Promise<void> {
    const rows = await this.drizzle.db
      .select()
      .from(walletCustodySweep)
      .where(
        and(
          inArray(walletCustodySweep.status, IN_FLIGHT_STATUSES),
          isNotNull(walletCustodySweep.externalId),
        ),
      )
      .orderBy(asc(walletCustodySweep.createdAt))
      .limit(batchSize);
    await mapConcurrent(rows, concurrency, async (row) => {
      const adapter = this.paymentProviders.get(row.providerName)?.adapter;
      if (!adapter?.getWithdrawalStatus || !row.externalId) {
        return;
      }
      const result = await adapter.getWithdrawalStatus(row.externalId);
      if (!result || result.status === 'processing') {
        return;
      }
      await this.drizzle.db
        .update(walletCustodySweep)
        .set({ status: result.status, txHash: result.txHash ?? row.txHash })
        .where(eq(walletCustodySweep.id, row.id));
    });
  }

  private async assetFor(currency: string, network: string): Promise<WalletAssetRow | null> {
    const [row] = await this.drizzle.db
      .select()
      .from(walletAsset)
      .where(and(eq(walletAsset.currency, currency), eq(walletAsset.network, network)));
    return row ?? null;
  }

  private async hasInFlightSweep(
    userId: User['id'],
    currency: string,
    network: string,
  ): Promise<boolean> {
    const [row] = await this.drizzle.db
      .select({ id: walletCustodySweep.id })
      .from(walletCustodySweep)
      .where(
        and(
          eq(walletCustodySweep.userId, userId),
          eq(walletCustodySweep.currency, currency),
          eq(walletCustodySweep.network, network),
          inArray(walletCustodySweep.status, IN_FLIGHT_STATUSES),
        ),
      );
    return row !== undefined;
  }

  private async getPoolBalanceCached(
    cache: Map<string, string>,
    adapter: PaymentAdapter,
    currency: string,
    network: string,
  ): Promise<string | null> {
    if (!adapter.getPoolBalance) {
      return null;
    }
    const key = `${currency}:${network}`;
    const cached = cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const balance = await adapter.getPoolBalance(currency, network);
    cache.set(key, balance);
    return balance;
  }

  private async processBalance({
    providerName,
    adapter,
    balance,
    runId,
    sweepConfig,
    summary,
    poolBalanceCache,
  }: {
    providerName: string;
    adapter: PaymentAdapter;
    balance: CustodyBalance;
    runId: Uuid;
    sweepConfig: SweepConfig;
    summary: SweepCycleSummary;
    poolBalanceCache: Map<string, string>;
  }): Promise<void> {
    const asset = await this.assetFor(balance.currency, balance.network);
    if (!asset) {
      // Funds sitting in a container the operator has no policy for must be visible,
      // not a log line.
      await recordReconciliationFinding(
        this.drizzle.db,
        {
          runId,
          providerName,
          kind: 'unconfigured_asset',
          currency: balance.currency,
          network: balance.network,
          amount: balance.amount,
          // No vendor reference exists for this finding, and the condition recurs every
          // single cycle until an operator configures the asset - without a stable
          // stand-in one missing catalog row files a finding every cron tick, drowning
          // the real findings and pinning the alert threshold permanently over the line.
          // The asset, not the player, is the subject: one row to act on, not one per
          // affected container.
          externalId: `unconfigured:${providerName}:${balance.currency}:${balance.network}`,
          detail: `no wallet_asset configured for ${balance.currency}/${balance.network}`,
        },
        this.audit,
      );
      return;
    }

    const gateArgs = {
      amount: balance.amount,
      estimatedFee: balance.estimatedFee,
      dustThreshold: asset.sweepDustThreshold ?? asset.minDeposit,
      feeMultiple: sweepConfig.feeMultiple,
      sweepFeeCeiling: asset.sweepFeeCeiling,
      poolLiquidityFloor: asset.poolLiquidityFloor,
    };
    let decision = gateSweepBalance({ ...gateArgs, poolBalance: null });
    // Only fetch the pool balance when the ceiling actually blocks - it's an extra
    // vendor call, not a free one.
    if (decision === 'ceiling' && asset.poolLiquidityFloor) {
      const poolBalance = await this.getPoolBalanceCached(
        poolBalanceCache,
        adapter,
        balance.currency,
        balance.network,
      );
      decision = gateSweepBalance({ ...gateArgs, poolBalance });
    }

    if (decision === 'dust') {
      summary.skippedDust += 1;
      return;
    }
    if (decision === 'fee') {
      summary.skippedFee += 1;
      return;
    }
    if (decision === 'ceiling') {
      summary.skippedCeiling += 1;
      return;
    }

    if (await this.hasInFlightSweep(balance.userId, balance.currency, balance.network)) {
      summary.inFlight += 1;
      return;
    }

    const [claimed] = await this.drizzle.db
      .insert(walletCustodySweep)
      .values({
        userId: balance.userId,
        providerName,
        currency: balance.currency,
        network: balance.network,
        amount: balance.amount,
        estimatedFee: balance.estimatedFee,
        status: 'pending',
        runId,
      })
      .onConflictDoNothing()
      .returning();
    if (!claimed) {
      // Another cycle claimed this (userId, currency, network) between the check above
      // and this insert - the partial unique index is the real guard, this is a race.
      summary.inFlight += 1;
      return;
    }

    // Deliberately outside any transaction - sweepToPool is a real vendor call
    // (docs/standards/money.md: treat external payment calls as non-transactional).
    // The claim row above already holds the durable guard.
    try {
      const treasuryRef = this.platformConfig?.wallet?.treasuryRef;
      const result = await adapter.sweepToPool?.(balance, {
        idempotencyKey: claimed.id,
        ...(treasuryRef ? { treasuryRef } : {}),
      });
      if (!result) {
        throw new Error(
          `provider "${providerName}" advertised listSweepableBalances but has no sweepToPool`,
        );
      }
      await this.drizzle.db
        .update(walletCustodySweep)
        // poolRef records WHICH pool received the funds, not just that a transfer
        // happened. Player funds must stay separate from operator funds, and that is
        // the question a regulator asks; without it the ledger cannot answer it.
        .set({
          status: 'processing',
          externalId: result.externalId,
          poolRef: result.poolRef ?? treasuryRef ?? null,
        })
        .where(eq(walletCustodySweep.id, claimed.id));
      summary.swept += 1;
    } catch (err) {
      // A thrown sweepToPool cannot distinguish "the vendor never saw it" from "the
      // vendor accepted it and the response was lost" - moving to `failed` on the
      // second case would let the next cycle sweep the same container again and
      // double-transfer real custody funds. `unknown` keeps the in-flight guard held
      // (see IN_FLIGHT_STATUSES) until reconciliation or an operator resolves it.
      logger.warn({ err, sweepId: claimed.id }, 'sweepToPool threw; parking sweep as unknown');
      await this.drizzle.db
        .update(walletCustodySweep)
        .set({ status: 'unknown' })
        .where(eq(walletCustodySweep.id, claimed.id));
      summary.unknown += 1;
    }
  }

  private async finishRun(
    jobRunId: WalletJobRun['id'],
    runId: Uuid,
    summary: SweepCycleSummary,
    status: 'completed' | 'failed' = 'completed',
    err?: unknown,
  ): Promise<void> {
    const error =
      err === undefined ? {} : { error: err instanceof Error ? err.message : String(err) };
    const moved = await this.drizzle.db
      .select()
      .from(walletCustodySweep)
      .where(and(eq(walletCustodySweep.runId, runId), eq(walletCustodySweep.status, 'processing')));

    await this.drizzle.db.transaction(async (txn) => {
      await txn
        .update(walletJobRun)
        .set({ finishedAt: new Date(), status, summary: { ...summary, ...error } })
        .where(eq(walletJobRun.id, jobRunId));
      for (const sweep of moved) {
        await this.audit.recordInTransaction(txn, {
          actorType: 'system',
          action: 'wallet.custody.sweep',
          resourceType: 'wallet_custody_sweep',
          resourceId: sweep.id,
          after: {
            runId,
            userId: sweep.userId,
            providerName: sweep.providerName,
            currency: sweep.currency,
            network: sweep.network,
            amount: sweep.amount,
            estimatedFee: sweep.estimatedFee,
            externalId: sweep.externalId,
            poolRef: sweep.poolRef,
          },
        });
      }
      await this.audit.recordInTransaction(txn, {
        actorType: 'system',
        action: 'wallet.custody.sweep_cycle',
        resourceType: 'wallet_job_run',
        resourceId: runId,
        after: { runId, status, ...summary, ...error },
      });
    });
  }
}
