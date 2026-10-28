import { and, count, desc, eq, type SQL } from 'drizzle-orm';
import type { AuditWritePort, ClientMeta, ExchangeRateReader, Uuid } from '@openora/core/contracts';
import {
  makeConflictError,
  makeNotFoundError,
  pageToOffset,
  type DrizzleService,
} from '@openora/core/server';
import { promoRakebackAccrual, type PromoRakebackAccrual } from '../schema/index.js';
import type {
  ListRakebackAccrualsInput,
  RakebackAccrual,
  RakebackLiability,
  RakebackPlayerSummary,
} from '../contract/index.js';
import { rakebackByCurrency, unclaimedRakeback } from '../shared/rakeback-totals.js';

export const RakebackAccrualNotFoundError = makeNotFoundError('RakebackAccrual');
export const RakebackAccrualNotVoidableError = makeConflictError(
  'RakebackAccrualNotVoidableError',
  'Only accrued rakeback can be voided',
);

const toAccrual = (row: PromoRakebackAccrual): RakebackAccrual => ({
  id: row.id,
  userId: row.userId,
  currency: row.currency,
  amount: row.amount,
  stake: row.stake,
  rolledBackStake: row.rolledBackStake,
  basis: row.basis,
  rtp: row.rtp,
  ratePercent: row.ratePercent,
  boostPercent: row.boostPercent,
  gameId: row.gameId,
  providerGameKey: row.providerGameKey,
  providerName: row.providerName,
  externalRoundId: row.externalRoundId,
  status: row.status,
  claimId: row.claimId,
  voidedBy: row.voidedBy,
  voidReason: row.voidReason,
  createdAt: row.createdAt.toISOString(),
  settledAt: row.settledAt?.toISOString() ?? null,
});

export class RakebackAdminService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly rates: ExchangeRateReader,
    private readonly audit: AuditWritePort,
    private readonly referenceCurrency: string,
  ) {}

  async listAccruals(input: ListRakebackAccrualsInput) {
    const conditions: SQL[] = [];
    if (input.userId) {
      conditions.push(eq(promoRakebackAccrual.userId, input.userId));
    }
    if (input.status) {
      conditions.push(eq(promoRakebackAccrual.status, input.status));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const db = this.drizzle.db;
    const [rows, [total]] = await Promise.all([
      db
        .select()
        .from(promoRakebackAccrual)
        .where(where)
        .orderBy(desc(promoRakebackAccrual.createdAt), desc(promoRakebackAccrual.id))
        .limit(input.limit)
        .offset(pageToOffset(input.page, input.limit)),
      db.select({ n: count() }).from(promoRakebackAccrual).where(where),
    ]);
    return {
      items: rows.map(toAccrual),
      total: Number(total?.n ?? 0),
      page: input.page,
      limit: input.limit,
    };
  }

  async playerSummary(userId: Uuid): Promise<RakebackPlayerSummary> {
    const db = this.drizzle.db;
    return {
      userId,
      ...(await unclaimedRakeback(db, this.rates, this.referenceCurrency, userId)),
      lifetimeClaimed: await rakebackByCurrency(db, 'claimed', userId),
    };
  }

  async liability(): Promise<RakebackLiability> {
    return unclaimedRakeback(this.drizzle.db, this.rates, this.referenceCurrency);
  }

  async void(
    adminId: Uuid,
    accrualId: Uuid,
    reason: string,
    meta: Partial<ClientMeta> = {},
  ): Promise<RakebackAccrual> {
    return this.drizzle.db.transaction(async (tx) => {
      const [voided] = await tx
        .update(promoRakebackAccrual)
        .set({ status: 'voided', voidedBy: adminId, voidReason: reason, settledAt: new Date() })
        .where(
          and(eq(promoRakebackAccrual.id, accrualId), eq(promoRakebackAccrual.status, 'accrued')),
        )
        .returning();
      if (!voided) {
        const [existing] = await tx
          .select({ id: promoRakebackAccrual.id })
          .from(promoRakebackAccrual)
          .where(eq(promoRakebackAccrual.id, accrualId));
        throw existing
          ? new RakebackAccrualNotVoidableError()
          : new RakebackAccrualNotFoundError(accrualId);
      }
      await this.audit.recordInTransaction(tx, {
        actorId: adminId,
        actorType: 'admin',
        action: 'promo.rakeback.voided',
        resourceType: 'promo_rakeback_accrual',
        resourceId: accrualId,
        before: { status: 'accrued' },
        after: {
          status: 'voided',
          userId: voided.userId,
          currency: voided.currency,
          amount: voided.amount,
          reason,
        },
        ...meta,
      });
      return toAccrual(voided);
    });
  }
}
