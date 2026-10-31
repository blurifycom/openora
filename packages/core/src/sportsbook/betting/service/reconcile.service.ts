import { and, asc, eq, lt, sql } from 'drizzle-orm';
import { createLogger, mapConcurrent, type DrizzleService } from '@openora/core/server';
import {
  SPORTSBOOK_RECONCILE_BATCH,
  SPORTSBOOK_RECONCILE_MAX_ATTEMPTS,
} from '../contract/index.js';
import {
  sportsbookBet,
  sportsbookReconciliationFinding,
  type SportsbookBetRow,
} from '../schema/index.js';
import { SportsbookBetChangedError, type SportsbookAlignService } from './align.service.js';
import type { SportsbookConfigService } from './config.service.js';
import { fileFinding } from './finding.service.js';

const logger = createLogger('sportsbook');

const PROVIDER_LOOKUP_CONCURRENCY = 4;

export type ReconcileSummary = { reservesChecked: number; overdueFiled: number };

export class SportsbookReconcileService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly config: SportsbookConfigService,
    private readonly align: SportsbookAlignService,
  ) {}

  async run(now = new Date()): Promise<ReconcileSummary> {
    const config = await this.config.get();
    const reserveCutoff = new Date(now.getTime() - config.reserveTimeoutSeconds * 1000);
    const settlementCutoff = new Date(now.getTime() - config.settlementGraceMinutes * 60_000);
    const reservesChecked = await this.reconcileReserves(reserveCutoff);
    const overdueFiled = await this.fileOverdueSettlements(settlementCutoff);
    return { reservesChecked, overdueFiled };
  }

  /** Every stale reserve visited leaves `reserved` or spends an attempt. */
  private async reconcileReserves(cutoff: Date): Promise<number> {
    const stale = await this.drizzle.db
      .select()
      .from(sportsbookBet)
      .where(
        and(
          eq(sportsbookBet.status, 'reserved'),
          lt(sportsbookBet.createdAt, cutoff),
          lt(sportsbookBet.reconcileAttempts, SPORTSBOOK_RECONCILE_MAX_ATTEMPTS),
        ),
      )
      .orderBy(asc(sportsbookBet.createdAt), asc(sportsbookBet.id))
      .limit(SPORTSBOOK_RECONCILE_BATCH);

    await mapConcurrent(stale, PROVIDER_LOOKUP_CONCURRENCY, async (bet) => {
      try {
        await this.align.apply(bet, await this.align.observe(bet), null);
      } catch (err) {
        if (!(err instanceof SportsbookBetChangedError)) {
          logger.warn({ err, betId: bet.id }, 'sportsbook: reconcile of a stale reserve failed');
        }
      }
      await this.spendAttempt(bet).catch((err: unknown) =>
        logger.error({ err, betId: bet.id }, 'sportsbook: reconcile attempt not recorded'),
      );
    });
    return stale.length;
  }

  private async spendAttempt(bet: SportsbookBetRow): Promise<void> {
    await this.drizzle.db.transaction(async (tx) => {
      const [row] = await tx
        .update(sportsbookBet)
        .set({ reconcileAttempts: sql`${sportsbookBet.reconcileAttempts} + 1` })
        .where(and(eq(sportsbookBet.id, bet.id), eq(sportsbookBet.status, 'reserved')))
        .returning({ reconcileAttempts: sportsbookBet.reconcileAttempts });
      if (!row || row.reconcileAttempts < SPORTSBOOK_RECONCILE_MAX_ATTEMPTS) {
        return;
      }
      await fileFinding(tx, {
        kind: 'reserve_unresolved',
        dedupeKey: `reserve_unresolved:${bet.id}`,
        provider: bet.provider,
        betId: bet.id,
        userId: bet.userId,
        detail: { attempts: row.reconcileAttempts, createdAt: bet.createdAt.toISOString() },
      });
    });
  }

  /** Skips a bet already filed at this version, open or resolved. */
  private async fileOverdueSettlements(cutoff: Date): Promise<number> {
    const result = await this.drizzle.db.execute<{ id: string }>(sql`
      INSERT INTO ${sportsbookReconciliationFinding} (kind, dedupe_key, provider, bet_id, user_id, detail)
      SELECT 'settlement_overdue', 'settlement_overdue:' || b.id || ':v' || b.version, b.provider, b.id, b.user_id,
        jsonb_build_object('version', b.version, 'lastLegStartsAt', b.last_leg_starts_at)
      FROM ${sportsbookBet} b
      WHERE b.status = 'accepted' AND b.last_leg_starts_at < ${cutoff}
        AND NOT EXISTS (
          SELECT 1 FROM ${sportsbookReconciliationFinding} f
          WHERE f.bet_id = b.id AND f.kind = 'settlement_overdue'
            AND f.dedupe_key = 'settlement_overdue:' || b.id || ':v' || b.version
        )
      ORDER BY b.last_leg_starts_at, b.id
      LIMIT ${SPORTSBOOK_RECONCILE_BATCH}
      ON CONFLICT (dedupe_key) WHERE status = 'open' DO NOTHING
      RETURNING id
    `);
    return result.rows.length;
  }
}
