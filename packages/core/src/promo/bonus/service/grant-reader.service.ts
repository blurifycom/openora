import { and, count, desc, eq } from 'drizzle-orm';
import { type PageQuery, type Paginated, type Uuid } from '@openora/core/contracts';
import {
  makeNotFoundError,
  pageToOffset,
  serializeRow,
  type DrizzleService,
} from '@openora/core/server';
import { promoGrant, type PromoGrant } from '../schema/index.js';
import type { AdminGrant, PlayerGrant } from '../contract/index.js';

export const GrantNotFoundError = makeNotFoundError('Grant');

const MONEY_FIELDS = [
  'grantedAmount',
  'bonusBalance',
  'wageringRequired',
  'wageringProgress',
] as const;
const DATE_FIELDS = ['expiresAt', 'closedAt', 'createdAt'] as const;
const SERIALIZE = { dateFields: [...DATE_FIELDS], decimalFields: [...MONEY_FIELDS] };

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

const ADMIN_COLUMNS = {
  ...COLUMNS,
  userId: promoGrant.userId,
  offerId: promoGrant.offerId,
  sourceRef: promoGrant.sourceRef,
};

/** What a player is allowed to see of their own bonuses. The terms snapshot stays internal. */
export class GrantReaderService {
  constructor(private readonly drizzle: DrizzleService) {}

  async list(
    userId: Uuid,
    query: PageQuery & { status?: PlayerGrant['status'] },
  ): Promise<Paginated<PlayerGrant>> {
    const { page, limit } = query;
    const where =
      query.status === undefined
        ? eq(promoGrant.userId, userId)
        : and(eq(promoGrant.userId, userId), eq(promoGrant.status, query.status));
    const [rows, [total]] = await Promise.all([
      this.drizzle.db
        .select(COLUMNS)
        .from(promoGrant)
        .where(where)
        .orderBy(desc(promoGrant.createdAt), desc(promoGrant.id))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      this.drizzle.db.select({ n: count() }).from(promoGrant).where(where),
    ]);
    return { items: rows.map(toPlayerGrant), total: Number(total?.n ?? 0), page, limit };
  }

  async listForAdmin(userId: Uuid, query: PageQuery): Promise<AdminGrant[]> {
    const rows = await this.drizzle.db
      .select(ADMIN_COLUMNS)
      .from(promoGrant)
      .where(eq(promoGrant.userId, userId))
      .orderBy(desc(promoGrant.createdAt), desc(promoGrant.id))
      .limit(query.limit)
      .offset(pageToOffset(query.page, query.limit));
    return rows.map(toAdminGrant);
  }

  async getForAdmin(id: PromoGrant['id']): Promise<AdminGrant> {
    const [row] = await this.drizzle.db
      .select(ADMIN_COLUMNS)
      .from(promoGrant)
      .where(eq(promoGrant.id, id));
    if (!row) {
      throw new GrantNotFoundError(id);
    }
    return toAdminGrant(row);
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

type PlayerGrantRow = {
  [K in keyof typeof COLUMNS]: PromoGrant[K & keyof PromoGrant];
};

type AdminGrantRow = {
  [K in keyof typeof ADMIN_COLUMNS]: PromoGrant[K & keyof PromoGrant];
};

function toAdminGrant(row: AdminGrantRow): AdminGrant {
  return serializeRow(row, SERIALIZE);
}

function toPlayerGrant(row: PlayerGrantRow): PlayerGrant {
  return serializeRow(row, SERIALIZE);
}
