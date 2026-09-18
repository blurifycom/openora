import { and, desc, eq } from 'drizzle-orm';
import { type Uuid } from '@openora/core/contracts';
import { makeNotFoundError, serializeRow, type DrizzleService } from '@openora/core/server';
import { promoGrant, type PromoGrant } from '../schema/index.js';
import type { PlayerGrant } from '../contract/index.js';

export const GrantNotFoundError = makeNotFoundError('Grant');

const MONEY_FIELDS = [
  'grantedAmount',
  'bonusBalance',
  'wageringRequired',
  'wageringProgress',
] as const;
const DATE_FIELDS = ['expiresAt', 'closedAt', 'createdAt'] as const;

const COLUMNS = {
  id: promoGrant.id,
  currency: promoGrant.currency,
  source: promoGrant.source,
  status: promoGrant.status,
  grantedAmount: promoGrant.grantedAmount,
  bonusBalance: promoGrant.bonusBalance,
  wageringRequired: promoGrant.wageringRequired,
  wageringProgress: promoGrant.wageringProgress,
  forfeitReason: promoGrant.forfeitReason,
  expiresAt: promoGrant.expiresAt,
  closedAt: promoGrant.closedAt,
  createdAt: promoGrant.createdAt,
};

/** What a player is allowed to see of their own bonuses. The terms snapshot stays internal. */
export class GrantReaderService {
  constructor(private readonly drizzle: DrizzleService) {}

  async list(userId: Uuid, status?: PlayerGrant['status']): Promise<PlayerGrant[]> {
    const rows = await this.drizzle.db
      .select(COLUMNS)
      .from(promoGrant)
      .where(
        status === undefined
          ? eq(promoGrant.userId, userId)
          : and(eq(promoGrant.userId, userId), eq(promoGrant.status, status)),
      )
      .orderBy(desc(promoGrant.createdAt), desc(promoGrant.id));
    return rows.map(toPlayerGrant);
  }

  /**
   * Scoped to the caller, and missing rather than forbidden when it belongs to someone else:
   * a 403 would confirm the id exists.
   */
  async get(userId: Uuid, id: PromoGrant['id']): Promise<PlayerGrant> {
    const [row] = await this.drizzle.db
      .select(COLUMNS)
      .from(promoGrant)
      .where(and(eq(promoGrant.id, id), eq(promoGrant.userId, userId)));
    if (!row) {
      throw new GrantNotFoundError(id);
    }
    return toPlayerGrant(row);
  }
}

function toPlayerGrant(row: typeof COLUMNS extends never ? never : Awaited<PlayerGrantRow>) {
  return serializeRow(row, {
    dateFields: [...DATE_FIELDS],
    decimalFields: [...MONEY_FIELDS],
  }) as PlayerGrant;
}

type PlayerGrantRow = {
  [K in keyof typeof COLUMNS]: PromoGrant[K & keyof PromoGrant];
};
