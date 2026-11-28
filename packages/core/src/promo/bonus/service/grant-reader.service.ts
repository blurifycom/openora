import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import {
  userContactsOf,
  MONEY_PRECISION,
  MONEY_SCALE,
  type BonusGrantLedgerReader,
  type IdentityReader,
  type PageQuery,
  type Paginated,
  type Uuid,
} from '@openora/core/contracts';
import {
  makeNotFoundError,
  pageToOffset,
  serializeRow,
  type DrizzleService,
} from '@openora/core/server';
import {
  promoGrant,
  promoGrantEntry,
  promoGrantRound,
  promoOffer,
  type PromoGrant,
} from '../schema/index.js';
import type { AdminGrant, BonusBalance, PlayerGrant, PlayerGrantEntry } from '../contract/index.js';

export const GrantNotFoundError = makeNotFoundError('Grant');

const MONEY_FIELDS = [
  'grantedAmount',
  'maxBet',
  'bonusBalance',
  'wageringRequired',
  'wageringProgress',
  'pendingWagered',
  'linkedCash',
  'unlinkedCash',
] as const;
const DATE_FIELDS = ['expiresAt', 'activatedAt', 'closedAt', 'createdAt'] as const;
const SERIALIZE = { dateFields: [...DATE_FIELDS], decimalFields: [...MONEY_FIELDS] };

const GRANT_COLUMNS = {
  id: promoGrant.id,
  offerId: promoGrant.offerId,
  currency: promoGrant.currency,
  source: promoGrant.source,
  sourceRef: promoGrant.sourceRef,
  status: promoGrant.status,
  grantedAmount: promoGrant.grantedAmount,
  bonusBalance: promoGrant.bonusBalance,
  wageringRequired: promoGrant.wageringRequired,
  wageringProgress: promoGrant.wageringProgress,
  pendingWagered: sql<string>`case when ${promoGrant.status} = 'active' then least(
    (
      select coalesce(sum(${promoGrantRound.progressPending}), 0)
      from ${promoGrantRound}
      where ${promoGrantRound.grantId} = ${promoGrant.id}
        and ${promoGrantRound.settledAt} is null
    ),
    greatest(${promoGrant.wageringRequired} - ${promoGrant.wageringProgress}, 0)
  ) else 0 end::numeric(${sql.raw(String(MONEY_PRECISION))}, ${sql.raw(String(MONEY_SCALE))})::text`,
  linkedCash: promoGrant.linkedCash,
  unlinkedCash: promoGrant.unlinkedCash,
  forfeitReason: promoGrant.forfeitReason,
  maxBet: sql<string | null>`${promoGrant.terms} ->> 'maxBet'`,
  playerForfeitable: sql<boolean>`coalesce((${promoGrant.terms}->>'allowPlayerForfeit')::boolean, false)`,
  expiresAt: promoGrant.expiresAt,
  activatedAt: promoGrant.activatedAt,
  closedAt: promoGrant.closedAt,
  createdAt: promoGrant.createdAt,
};

const COLUMNS = {
  ...GRANT_COLUMNS,
  offerKey: promoOffer.key,
  offerName: promoOffer.name,
};

const withOffer = eq(promoOffer.id, promoGrant.offerId);

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
  forfeitNote: promoGrant.forfeitNote,
  forfeitedById: promoGrant.forfeitedBy,
  closedAmount: sql<string | null>`case when ${promoGrant.status} in ('forfeited', 'expired') then (
    select abs(sum(${promoGrantEntry.bonusAmount}))::text
    from ${promoGrantEntry}
    where ${promoGrantEntry.grantId} = ${promoGrant.id}
      and ${promoGrantEntry.type} in ('forfeit', 'expire')
  ) end`,
};

export const bonusGrantLedger: BonusGrantLedgerReader = {
  ledgerRowsQuery: (userId) => sql`
    select
      ${promoGrant.id} as id,
      case ${promoGrant.source}
        when 'gift' then 'gift' when 'rain' then 'rain' when 'donation' then 'donation'
        when 'cashback' then 'cashback'
        else 'bonus'
      end as type,
      ${promoGrant.grantedAmount} as amount,
      ${promoGrant.currency} as currency,
      case
        when ${promoGrant.status} = 'pending' then 'pending'
        when ${promoGrant.status} = 'cancelled' or ${promoGrant.activatedAt} is null then 'cancelled'
        else 'completed'
      end as status,
      ${promoGrant.createdAt} as created_at
    from ${promoGrant}
    where ${promoGrant.userId} = ${userId}`,
};

export class GrantReaderService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly identity: IdentityReader,
  ) {}

  private async withForfeitActors(rows: readonly UnnamedAdminGrantRow[]): Promise<AdminGrant[]> {
    const contacts = await userContactsOf(
      this.identity,
      rows.flatMap((row) => (row.forfeitedById === null ? [] : [row.forfeitedById])),
    );
    return rows.map((row) => {
      const contact = row.forfeitedById === null ? undefined : contacts.get(row.forfeitedById);
      return toAdminGrant({
        ...row,
        forfeitedByName: contact?.name ?? null,
        forfeitedByEmail: contact?.email ?? null,
      });
    });
  }

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
        .leftJoin(promoOffer, withOffer)
        .where(where)
        .orderBy(desc(promoGrant.createdAt), desc(promoGrant.id))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      this.drizzle.db.select({ n: count() }).from(promoGrant).where(where),
    ]);
    return { items: rows.map(toPlayerGrant), total: Number(total?.n ?? 0), page, limit };
  }

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
    const attributed = await this.drizzle.db
      .selectDistinctOn([promoGrant.currency], {
        currency: promoGrant.currency,
        maxBet: sql<string | null>`${promoGrant.terms} ->> 'maxBet'`,
      })
      .from(promoGrant)
      .where(
        and(
          eq(promoGrant.userId, userId),
          eq(promoGrant.status, 'active'),
          sql`${promoGrant.expiresAt} > now()`,
          currency === undefined ? undefined : eq(promoGrant.currency, currency),
        ),
      )
      .orderBy(
        asc(promoGrant.currency),
        asc(promoGrant.expiresAt),
        asc(promoGrant.createdAt),
        asc(promoGrant.id),
      );
    const maxBetByCurrency = new Map(attributed.map((row) => [row.currency, row.maxBet]));
    return rows.map((row) => ({
      ...row,
      activeGrants: Number(row.activeGrants),
      maxBet: maxBetByCurrency.get(row.currency) ?? null,
    }));
  }

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
      .leftJoin(promoOffer, withOffer)
      .where(eq(promoGrant.userId, userId))
      .orderBy(desc(promoGrant.createdAt), desc(promoGrant.id))
      .limit(query.limit)
      .offset(pageToOffset(query.page, query.limit));
    return this.withForfeitActors(rows);
  }

  async getForAdmin(id: PromoGrant['id']): Promise<AdminGrant> {
    const [row] = await this.drizzle.db
      .select(ADMIN_COLUMNS)
      .from(promoGrant)
      .leftJoin(promoOffer, withOffer)
      .where(eq(promoGrant.id, id));
    if (!row) {
      throw new GrantNotFoundError(id);
    }
    const [grant] = await this.withForfeitActors([row]);
    return grant;
  }

  async get(userId: Uuid, id: PromoGrant['id']): Promise<PlayerGrant> {
    const [row] = await this.drizzle.db
      .select(COLUMNS)
      .from(promoGrant)
      .leftJoin(promoOffer, withOffer)
      .where(and(eq(promoGrant.id, id), eq(promoGrant.userId, userId)));
    if (!row) {
      throw new GrantNotFoundError(id);
    }
    return toPlayerGrant(row);
  }
}

type OfferLabel = { offerKey: string | null; offerName: string | null };

type PlayerGrantRow = {
  [K in Exclude<
    keyof typeof GRANT_COLUMNS,
    'maxBet' | 'playerForfeitable' | 'pendingWagered'
  >]: PromoGrant[K];
} & OfferLabel & { maxBet: string | null; playerForfeitable: boolean; pendingWagered: string };

type AdminGrantRow = PlayerGrantRow & {
  userId: PromoGrant['userId'];
  forfeitNote: PromoGrant['forfeitNote'];
  forfeitedById: PromoGrant['forfeitedBy'];
  forfeitedByName: string | null;
  forfeitedByEmail: string | null;
  closedAmount: string | null;
};

type UnnamedAdminGrantRow = Omit<AdminGrantRow, 'forfeitedByName' | 'forfeitedByEmail'>;

function toAdminGrant({
  forfeitedById,
  forfeitedByName,
  forfeitedByEmail,
  ...row
}: AdminGrantRow): AdminGrant {
  return {
    ...serializeRow(row, SERIALIZE),
    forfeitedBy:
      forfeitedById === null
        ? null
        : { id: forfeitedById, name: forfeitedByName, email: forfeitedByEmail },
  };
}

function toPlayerGrant(row: PlayerGrantRow): PlayerGrant {
  return serializeRow(row, SERIALIZE);
}
