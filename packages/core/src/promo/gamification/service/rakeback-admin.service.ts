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
import { claimedByCurrency, unclaimedRakeback } from '../shared/rakeback-totals.js';

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

type RakebackAdminDeps = {
  drizzle: DrizzleService;
  rates: ExchangeRateReader;
  audit: AuditWritePort;
  referenceCurrency: string;
};

type VoidRakebackArgs = {
  adminId: Uuid;
  accrualId: Uuid;
  reason: string;
  meta?: Partial<ClientMeta>;
};

export class RakebackAdminService {
  constructor(private readonly deps: RakebackAdminDeps) {}

  async listAccruals(input: ListRakebackAccrualsInput) {
    const conditions: SQL[] = [];
    if (input.userId) {
      conditions.push(eq(promoRakebackAccrual.userId, input.userId));
    }
    if (input.status) {
      conditions.push(eq(promoRakebackAccrual.status, input.status));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const db = this.deps.drizzle.db;
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
    const db = this.deps.drizzle.db;
    return {
      userId,
      ...(await unclaimedRakeback(db, this.deps.rates, this.deps.referenceCurrency, userId)),
      lifetimeClaimed: await claimedByCurrency(db, userId),
    };
  }

  async liability(): Promise<RakebackLiability> {
    return unclaimedRakeback(this.deps.drizzle.db, this.deps.rates, this.deps.referenceCurrency);
  }

  async void({
    adminId,
    accrualId,
    reason,
    meta = {},
  }: VoidRakebackArgs): Promise<RakebackAccrual> {
    return this.deps.drizzle.db.transaction(async (tx) => {
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
      await this.deps.audit.recordInTransaction(tx, {
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
