import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import { type PageQuery, type Paginated, type Uuid } from '@openora/core/contracts';
import {
  makeNotFoundError,
  pageToOffset,
  serializeRow,
  type DrizzleService,
} from '@openora/core/server';
import { promoGrant, promoGrantEntry, type PromoGrant } from '../schema/index.js';
import type { AdminGrant, BonusBalance, PlayerGrant, PlayerGrantEntry } from '../contract/index.js';

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

const ENTRY_COLUMNS = {
  id: promoGrantEntry.id,
  type: promoGrantEntry.type,
  currency: promoGrantEntry.currency,
  bonusAmount: promoGrantEntry.bonusAmount,
  realAmount: promoGrantEntry.realAmount,
  wageringDelta: promoGrantEntry.wageringDelta,
  balanceAfter: promoGrantEntry.balanceAfter,
  createdAt: promoGrantEntry.createdAt,
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

  /**
   * One row per currency the player holds live bonus funds in. Summed from the grants rather
   * than read off a balance column, because the grants are where the funds are: there is no
   * second place for the two to disagree.
   */
  async balances(userId: Uuid, currency?: string): Promise<BonusBalance[]> {
    const rows = await this.drizzle.db
      .select({
        currency: promoGrant.currency,
        bonus: sql<string>`sum(${promoGrant.bonusBalance})::text`,
        wageringRequired: sql<string>`sum(${promoGrant.wageringRequired})::text`,
        wageringProgress: sql<string>`sum(${promoGrant.wageringProgress})::text`,
        activeGrants: count(),
      })
      .from(promoGrant)
      .where(
        and(
          eq(promoGrant.userId, userId),
          eq(promoGrant.status, 'active'),
          currency === undefined ? undefined : eq(promoGrant.currency, currency),
        ),
      )
      .groupBy(promoGrant.currency)
      .orderBy(asc(promoGrant.currency));
    return rows.map((row) => ({ ...row, activeGrants: Number(row.activeGrants) }));
  }

  /** The movements behind one of the caller's own grants; someone else's id is simply missing. */
  async entries(
    userId: Uuid,
    id: PromoGrant['id'],
    query: PageQuery,
  ): Promise<Paginated<PlayerGrantEntry>> {
    const { page, limit } = query;
    await this.get(userId, id);
    const where = and(eq(promoGrantEntry.grantId, id), eq(promoGrantEntry.userId, userId));
    const [rows, [total]] = await Promise.all([
      this.drizzle.db
        .select(ENTRY_COLUMNS)
        .from(promoGrantEntry)
        .where(where)
        .orderBy(desc(promoGrantEntry.createdAt), desc(promoGrantEntry.id))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      this.drizzle.db.select({ n: count() }).from(promoGrantEntry).where(where),
    ]);
    const items = rows.map((row) =>
      serializeRow(row, {
        dateFields: ['createdAt'],
        decimalFields: ['bonusAmount', 'realAmount', 'wageringDelta', 'balanceAfter'],
      }),
    );
    return { items, total: Number(total?.n ?? 0), page, limit };
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
