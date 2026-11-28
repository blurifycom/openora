import {
  createLogger,
  isPositiveMoney,
  moneyAdd,
  moneyCompare,
  moneyEquals,
  moneyMultiplyDivide,
  moneyScaleBy,
  moneySubtract,
  type DrizzleDb,
  type DrizzleService,
  type EventBus,
} from '@openora/core/server';
import {
  TurnoverDisabledError,
  TurnoverLockedError,
  WAGER_PRODUCTS,
  WalletCommandAmountError,
  WalletReplayMismatchError,
  isTurnoverEnabled,
  queue,
  type AddTurnoverRequirementArgs,
  type AddTurnoverRequirementResult,
  type AdminTurnoverEntry,
  type AuditWritePort,
  type ClientMeta,
  type ExchangeRateReader,
  type TurnoverCreditType,
  type TurnoverEntry,
  type TurnoverEntrySource,
  type TurnoverOutflow,
  type TurnoverStakeState,
  type TurnoverSummary,
  type User,
  type WagerProduct,
  type WalletTurnoverConfig,
} from '@openora/core/contracts';
import { and, desc, eq, gt, inArray, or, sql, type SQL } from 'drizzle-orm';
import * as z from 'zod';
import {
  walletTransaction,
  walletTurnover,
  walletTurnoverConfig,
  walletTurnoverEntry,
} from '../schema/index.js';
import type {
  AdminTurnoverEntriesPage,
  TurnoverConfigView,
  TurnoverEntriesPage,
  TurnoverEntriesQuery,
  UpdateTurnoverConfigInput,
} from '../contract/index.js';

const CONFIG_KEY = 'global';
const PRICING_PAGE = 500;
const AUDITED_ENTRY_IDS = 100;

export const TURNOVER_PRICING_QUEUE = queue('wallet-turnover-pricing');
export const TurnoverPricingJobSchema = z.object({});

type EntryRow = typeof walletTurnoverEntry.$inferSelect;
type TurnoverRow = typeof walletTurnover.$inferSelect;
type ProductOverrides = Partial<Record<WagerProduct, number>>;

type NewEntry = {
  userId: User['id'];
  source: TurnoverEntrySource;
  sourceRef: string;
  currency: string;
  amount: string;
  multiplier: string;
};

export type TurnoverCredit = {
  userId: User['id'];
  kind: TurnoverCreditType;
  sourceRef: string;
  currency: string;
  amount: string;
};

export type TurnoverServiceDeps = {
  drizzle: DrizzleService;
  events: EventBus;
  audit: AuditWritePort;
  config: WalletTurnoverConfig;
  pivotCurrency: string;
  rates?: ExchangeRateReader;
  logger?: ReturnType<typeof createLogger>;
};

export type TurnoverStakeStamp = {
  contribution: string;
  state: Exclude<TurnoverStakeState, 'reversal'>;
};

type PendingRates = ReadonlyMap<string, string>;

const rateKey = (currency: string, pivotCurrency: string): string =>
  `${currency.toUpperCase()}>${pivotCurrency}`;

type LedgerRow = typeof walletTransaction.$inferSelect;

export type TurnoverStake = {
  userId: User['id'];
  product: WagerProduct | undefined;
  currency: string;
  realPart: string;
};

export type TurnoverRound = {
  userId: User['id'];
  walletId: LedgerRow['walletId'];
  currency: string;
  providerName: string;
  externalRoundId: string;
};

export type TurnoverReversal = Omit<TurnoverRound, 'externalRoundId'> & {
  externalRoundId: string | undefined;
  ledgerRowId: LedgerRow['id'];
  amount: string;
  reversesTransactionId: LedgerRow['id'] | undefined;
};

type RoundSums = { counted: string; deferred: string; reversed: string; staked: string };

const maxZero = (amount: string): string => (moneyCompare(amount, '0') > 0 ? amount : '0');
const minMoney = (a: string, b: string): string => (moneyCompare(a, b) <= 0 ? a : b);

function toEntry(row: EntryRow): TurnoverEntry {
  return {
    id: row.id,
    source: row.source,
    currency: row.currency,
    amount: row.amount,
    multiplier: row.multiplier,
    pivotValue: row.pivotValue,
    required: row.required,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    pricedAt: row.pricedAt?.toISOString() ?? null,
    clearedAt: row.clearedAt?.toISOString() ?? null,
  };
}

function toAdminEntry(row: EntryRow): AdminTurnoverEntry {
  return { ...toEntry(row), clearedBy: row.clearedBy, clearReason: row.clearReason };
}

export class TurnoverService {
  private readonly logger: ReturnType<typeof createLogger>;

  constructor(private readonly deps: TurnoverServiceDeps) {
    this.logger = deps.logger ?? createLogger('wallet');
  }

  get enabled(): boolean {
    return isTurnoverEnabled(this.deps.config);
  }

  private on(tx?: unknown): DrizzleDb {
    return tx === undefined ? this.deps.drizzle.db : (tx as DrizzleDb);
  }

  private emptySummary(enabled: boolean): TurnoverSummary {
    return {
      enabled,
      pivotCurrency: this.deps.pivotCurrency,
      required: '0',
      progress: '0',
      remaining: '0',
      dustThreshold: this.deps.config.dustThreshold,
      locked: false,
      pendingCount: 0,
      updatedAt: null,
    };
  }

  private isMet(row: TurnoverRow): boolean {
    const remaining = maxZero(moneySubtract(row.required, row.progress));
    return moneyCompare(remaining, this.deps.config.dustThreshold) <= 0 && row.pendingCount === 0;
  }

  private toSummary(row: TurnoverRow): TurnoverSummary {
    const remaining = maxZero(moneySubtract(row.required, row.progress));
    return {
      enabled: true,
      pivotCurrency: row.pivotCurrency,
      required: row.required,
      progress: row.progress,
      remaining,
      dustThreshold: this.deps.config.dustThreshold,
      locked: !this.isMet(row),
      pendingCount: row.pendingCount,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async summary(userId: User['id'], tx?: unknown): Promise<TurnoverSummary> {
    if (!this.enabled) {
      return this.emptySummary(false);
    }
    const [row] = await this.on(tx)
      .select()
      .from(walletTurnover)
      .where(eq(walletTurnover.userId, userId));
    return row ? this.toSummary(row) : this.emptySummary(true);
  }

  async adminSummary(userId: User['id']): Promise<TurnoverSummary> {
    const row = await this.readRow(this.deps.drizzle.db, userId);
    if (!row) {
      return this.emptySummary(this.enabled);
    }
    const summary = this.toSummary(row);
    return this.enabled ? summary : { ...summary, enabled: false, locked: false };
  }

  private async entryRows(
    userId: User['id'],
    { cursor, limit }: TurnoverEntriesQuery,
    { whileOff }: { whileOff: boolean },
  ): Promise<{ rows: EntryRow[]; nextCursor: string | null }> {
    if (!this.enabled && !whileOff) {
      return { rows: [], nextCursor: null };
    }
    const after =
      cursor === undefined
        ? undefined
        : sql`(${walletTurnoverEntry.createdAt}, ${walletTurnoverEntry.id}) < (select ${walletTurnoverEntry.createdAt}, ${walletTurnoverEntry.id} from ${walletTurnoverEntry} where ${walletTurnoverEntry.id} = ${cursor} and ${walletTurnoverEntry.userId} = ${userId})`;
    const rows = await this.deps.drizzle.db
      .select()
      .from(walletTurnoverEntry)
      .where(and(eq(walletTurnoverEntry.userId, userId), after))
      .orderBy(desc(walletTurnoverEntry.createdAt), desc(walletTurnoverEntry.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    return {
      rows: page,
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async entries(userId: User['id'], query: TurnoverEntriesQuery): Promise<TurnoverEntriesPage> {
    const { rows, nextCursor } = await this.entryRows(userId, query, { whileOff: false });
    return { items: rows.map(toEntry), nextCursor };
  }

  async adminEntries(
    userId: User['id'],
    query: TurnoverEntriesQuery,
  ): Promise<AdminTurnoverEntriesPage> {
    const { rows, nextCursor } = await this.entryRows(userId, query, { whileOff: true });
    return { items: rows.map(toAdminEntry), nextCursor };
  }

  async clear(
    adminId: User['id'],
    { userId, reason }: { userId: User['id']; reason: string },
    meta?: ClientMeta,
  ): Promise<{ cleared: boolean; summary: TurnoverSummary }> {
    return this.deps.drizzle.db.transaction(async (tx) => {
      const row = await this.lockRow(tx, userId);
      if (!row) {
        return { cleared: false, summary: await this.summary(userId, tx) };
      }
      const [stamp] = await tx
        .select({ at: sql<string>`clock_timestamp()::text` })
        .from(walletTurnover)
        .where(eq(walletTurnover.userId, userId));
      if (!stamp) {
        throw new Error('turnover row missing under its lock');
      }
      const now = sql<Date>`${stamp.at}::timestamptz`;
      const cleared = await tx
        .update(walletTurnoverEntry)
        .set({ status: 'cleared', clearedAt: now, clearedBy: adminId, clearReason: reason })
        .where(
          and(
            eq(walletTurnoverEntry.userId, userId),
            inArray(walletTurnoverEntry.status, ['counted', 'pending']),
          ),
        )
        .returning({ id: walletTurnoverEntry.id });
      const owes =
        moneyCompare(row.required, '0') !== 0 ||
        moneyCompare(row.progress, '0') !== 0 ||
        row.pendingCount > 0 ||
        cleared.length > 0;
      if (!owes) {
        return { cleared: false, summary: await this.summary(userId, tx) };
      }
      const before = this.toSummary(row);
      const [updated] = await tx
        .update(walletTurnover)
        .set({ required: '0', progress: '0', pendingCount: 0, clearedAt: now })
        .where(eq(walletTurnover.userId, userId))
        .returning();
      const after = this.toSummary(updated ?? row);
      await this.deps.audit.recordInTransaction(tx, {
        actorId: adminId,
        actorType: 'admin',
        action: 'wallet.turnover.cleared',
        resourceType: 'wallet_turnover',
        resourceId: userId,
        before: {
          pivotCurrency: before.pivotCurrency,
          required: before.required,
          progress: before.progress,
          remaining: before.remaining,
          pendingCount: before.pendingCount,
        },
        after: {
          required: after.required,
          progress: after.progress,
          remaining: after.remaining,
          pendingCount: after.pendingCount,
          reason,
          entryCount: cleared.length,
          entryIds: cleared.slice(0, AUDITED_ENTRY_IDS).map((entry) => entry.id),
        },
        ...meta,
      });
      await this.deps.events.emitInTransaction(tx, 'wallet.turnover.cleared', {
        userId,
        clearedBy: adminId,
        pivotCurrency: before.pivotCurrency,
        required: before.required,
        progress: before.progress,
      });
      return { cleared: true, summary: this.enabled ? after : this.emptySummary(false) };
    });
  }

  private async overrides(tx?: unknown): Promise<ProductOverrides> {
    const [row] = await this.on(tx)
      .select({ productPercent: walletTurnoverConfig.productPercent })
      .from(walletTurnoverConfig)
      .where(eq(walletTurnoverConfig.singletonKey, CONFIG_KEY));
    return row?.productPercent ?? {};
  }

  private configView(overrides: ProductOverrides): TurnoverConfigView {
    const { multiplier, creditTypes, countAtSettle, dustThreshold, productPercent } =
      this.deps.config;
    return {
      multiplier,
      creditTypes,
      countAtSettle,
      dustThreshold,
      pivotCurrency: this.deps.pivotCurrency,
      productPercent: { ...productPercent, ...overrides },
      overrides,
    };
  }

  async getConfig(): Promise<TurnoverConfigView> {
    return this.configView(await this.overrides());
  }

  async updateConfig(
    adminId: User['id'],
    { productPercent }: UpdateTurnoverConfigInput,
    meta?: ClientMeta,
  ): Promise<TurnoverConfigView> {
    return this.deps.drizzle.db.transaction(async (tx) => {
      await tx
        .insert(walletTurnoverConfig)
        .values({ singletonKey: CONFIG_KEY })
        .onConflictDoNothing({ target: walletTurnoverConfig.singletonKey });
      const [current] = await tx
        .select({ productPercent: walletTurnoverConfig.productPercent })
        .from(walletTurnoverConfig)
        .where(eq(walletTurnoverConfig.singletonKey, CONFIG_KEY))
        .for('update');
      const before = current?.productPercent ?? {};
      const next: ProductOverrides = {};
      for (const product of WAGER_PRODUCTS) {
        const change = productPercent[product];
        const value = change === undefined ? before[product] : change;
        if (value !== undefined && value !== null) {
          next[product] = value;
        }
      }
      await tx
        .update(walletTurnoverConfig)
        .set({ productPercent: next, updatedBy: adminId })
        .where(eq(walletTurnoverConfig.singletonKey, CONFIG_KEY));
      await this.deps.audit.recordInTransaction(tx, {
        actorId: adminId,
        actorType: 'admin',
        action: 'wallet.turnover_config.updated',
        resourceType: 'wallet_turnover_config',
        resourceId: null,
        before: { productPercent: before },
        after: { productPercent: next },
        ...meta,
      });
      return this.configView(next);
    });
  }

  private async price({
    amount,
    currency,
    pivotCurrency,
    tx,
  }: {
    amount: string;
    currency: string;
    pivotCurrency: string;
    tx: unknown;
  }): Promise<string | null> {
    const rate = await this.rate(currency, pivotCurrency, tx);
    return rate === null ? null : moneyScaleBy(amount, rate);
  }

  private async rate(currency: string, pivotCurrency: string, tx: unknown): Promise<string | null> {
    if (currency.toUpperCase() === pivotCurrency) {
      return '1';
    }
    return (await this.deps.rates?.getRate(currency, pivotCurrency, tx))?.rate ?? null;
  }

  private async findReplay(
    db: DrizzleDb,
    entry: NewEntry,
  ): Promise<AddTurnoverRequirementResult | null> {
    const [existing] = await db
      .select()
      .from(walletTurnoverEntry)
      .where(
        and(
          eq(walletTurnoverEntry.source, entry.source),
          eq(walletTurnoverEntry.sourceRef, entry.sourceRef),
        ),
      );
    if (!existing) {
      return null;
    }
    if (
      existing.userId !== entry.userId ||
      existing.currency !== entry.currency.toUpperCase() ||
      !moneyEquals(existing.amount, entry.amount)
    ) {
      throw new WalletReplayMismatchError(entry.source, entry.sourceRef, existing.id);
    }
    return { entryId: existing.id, status: existing.status, replayed: true };
  }

  private async lockRow(db: DrizzleDb, userId: User['id']): Promise<TurnoverRow | undefined> {
    const [row] = await db
      .select()
      .from(walletTurnover)
      .where(eq(walletTurnover.userId, userId))
      .for('update');
    return row;
  }

  private async lockSinceClear(
    db: DrizzleDb,
    userId: User['id'],
  ): Promise<{ row: TurnoverRow; clearedSinceStart: boolean } | undefined> {
    const [locked] = await db
      .select({
        row: walletTurnover,
        clearedSinceStart: sql<boolean>`coalesce(${walletTurnover.clearedAt} >= now(), false)`,
      })
      .from(walletTurnover)
      .where(eq(walletTurnover.userId, userId))
      .for('update');
    return locked;
  }

  private async readRow(db: DrizzleDb, userId: User['id']): Promise<TurnoverRow | undefined> {
    const [row] = await db.select().from(walletTurnover).where(eq(walletTurnover.userId, userId));
    return row;
  }

  private async writeRow(
    db: DrizzleDb,
    row: TurnoverRow,
    values: Partial<Pick<TurnoverRow, 'required' | 'progress' | 'pendingCount'>>,
  ): Promise<void> {
    const [updated] = await db
      .update(walletTurnover)
      .set(values)
      .where(eq(walletTurnover.userId, row.userId))
      .returning();
    if (updated && !this.isMet(row) && this.isMet(updated)) {
      await this.deps.events.emitInTransaction(db, 'wallet.turnover.met', {
        userId: updated.userId,
        pivotCurrency: updated.pivotCurrency,
        required: updated.required,
        progress: updated.progress,
      });
    }
  }

  private countable(row: TurnoverRow, contribution: string): string {
    return row.pendingCount > 0
      ? contribution
      : minMoney(contribution, maxZero(moneySubtract(row.required, row.progress)));
  }

  private async moveProgress(db: DrizzleDb, userId: User['id'], delta: string): Promise<void> {
    const row = await this.lockRow(db, userId);
    if (!row) {
      return;
    }
    await this.writeRow(db, row, { progress: maxZero(moneyAdd(row.progress, delta)) });
  }

  private async addEntry(tx: unknown, entry: NewEntry): Promise<AddTurnoverRequirementResult> {
    const db = tx as DrizzleDb;
    const replay = await this.findReplay(db, entry);
    if (replay) {
      return replay;
    }
    const pivotCurrency =
      (await this.readRow(db, entry.userId))?.pivotCurrency ?? this.deps.pivotCurrency;
    const pivotValue = await this.price({
      amount: entry.amount,
      currency: entry.currency,
      pivotCurrency,
      tx,
    });
    await db
      .insert(walletTurnover)
      .values({ userId: entry.userId, pivotCurrency: this.deps.pivotCurrency })
      .onConflictDoNothing({ target: walletTurnover.userId });
    const row = await this.lockRow(db, entry.userId);
    if (!row) {
      throw new Error('turnover row missing after its upsert');
    }
    const requiredInCurrency = moneyScaleBy(entry.amount, entry.multiplier);
    const required = pivotValue === null ? null : moneyScaleBy(pivotValue, entry.multiplier);
    const [inserted] = await db
      .insert(walletTurnoverEntry)
      .values({
        ...entry,
        currency: entry.currency.toUpperCase(),
        requiredInCurrency,
        pivotValue,
        required,
        status: required === null ? 'pending' : 'counted',
        pricedAt: required === null ? null : new Date(),
      })
      .onConflictDoNothing({
        target: [walletTurnoverEntry.source, walletTurnoverEntry.sourceRef],
      })
      .returning({ id: walletTurnoverEntry.id, status: walletTurnoverEntry.status });
    if (!inserted) {
      const existing = await this.findReplay(db, entry);
      if (!existing) {
        throw new Error('turnover entry missing after its conflict');
      }
      return existing;
    }
    const progress = this.isMet(row) ? row.required : row.progress;
    await this.writeRow(
      db,
      row,
      required === null
        ? { progress, pendingCount: row.pendingCount + 1 }
        : { progress, required: moneyAdd(row.required, required) },
    );
    return { entryId: inserted.id, status: inserted.status, replayed: false };
  }

  async addRequirement(
    tx: unknown,
    { userId, currency, requiredInCurrency, source, sourceRef }: AddTurnoverRequirementArgs,
  ): Promise<AddTurnoverRequirementResult> {
    if (!this.enabled) {
      throw new TurnoverDisabledError();
    }
    if (!isPositiveMoney(requiredInCurrency)) {
      throw new WalletCommandAmountError('turnover requirement', requiredInCurrency);
    }
    return this.addEntry(tx, {
      userId,
      source,
      sourceRef,
      currency,
      amount: requiredInCurrency,
      multiplier: '1',
    });
  }

  async addCredit(
    tx: unknown,
    { kind, ...credit }: TurnoverCredit,
  ): Promise<AddTurnoverRequirementResult | null> {
    if (!this.enabled || !this.deps.config.creditTypes.includes(kind)) {
      return null;
    }
    return this.addEntry(tx, { ...credit, source: kind, multiplier: this.deps.config.multiplier });
  }

  async pricePending(tx: unknown, userId: User['id'], rates?: PendingRates): Promise<number> {
    const db = tx as DrizzleDb;
    const current = await this.readRow(db, userId);
    if (!current) {
      return 0;
    }
    const pending = await db
      .select()
      .from(walletTurnoverEntry)
      .where(and(eq(walletTurnoverEntry.userId, userId), eq(walletTurnoverEntry.status, 'pending')))
      .orderBy(walletTurnoverEntry.id);
    const known = new Map<string, string | null>(rates);
    for (const { currency } of pending) {
      const key = rateKey(currency, current.pivotCurrency);
      if (!known.has(key)) {
        known.set(key, rates ? null : await this.rate(currency, current.pivotCurrency, db));
      }
    }
    const quotes = pending.flatMap((entry) => {
      const rate = known.get(rateKey(entry.currency, current.pivotCurrency));
      if (rate === null || rate === undefined) {
        return [];
      }
      const pivotValue = moneyScaleBy(entry.amount, rate);
      return [{ id: entry.id, pivotValue, required: moneyScaleBy(pivotValue, entry.multiplier) }];
    });
    if (quotes.length === 0) {
      return 0;
    }
    const row = await this.lockRow(db, userId);
    if (!row) {
      return 0;
    }
    const values = sql.join(
      quotes.map(
        ({ id, pivotValue, required }) =>
          sql`(${id}::uuid, ${pivotValue}::numeric, ${required}::numeric)`,
      ),
      sql`, `,
    );
    const { rows: priced } = await db.execute<{ required: string }>(sql`
      update ${walletTurnoverEntry}
      set status = 'counted', pivot_value = v.pivot_value, required = v.required, priced_at = now()
      from (values ${values}) as v(id, pivot_value, required)
      where ${walletTurnoverEntry.id} = v.id and ${walletTurnoverEntry.status} = 'pending'
      returning ${walletTurnoverEntry.required} as required`);
    if (priced.length > 0) {
      await this.writeRow(db, row, {
        required: priced.reduce((sum, entry) => moneyAdd(sum, entry.required), row.required),
        pendingCount: Math.max(row.pendingCount - priced.length, 0),
      });
    }
    return priced.length;
  }

  async pricePendingNow(userId: User['id']): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const row = await this.readRow(this.deps.drizzle.db, userId);
    if (!row || row.pendingCount === 0) {
      return;
    }
    await this.deps.drizzle.db.transaction((tx) => this.pricePending(tx, userId));
  }

  async refusal(
    tx: unknown,
    { userId, outflow }: { userId: User['id']; outflow: TurnoverOutflow },
  ): Promise<TurnoverLockedError | null> {
    if (!this.enabled) {
      return null;
    }
    const row = await this.lockRow(tx as DrizzleDb, userId);
    if (!row || this.isMet(row)) {
      return null;
    }
    const { pivotCurrency, required, progress, remaining } = this.toSummary(row);
    return new TurnoverLockedError(this.deps.config.lockedMessage, {
      outflow,
      pivotCurrency,
      required,
      progress,
      remaining,
      pending: row.pendingCount > 0,
    });
  }

  async assertOutflow(
    tx: unknown,
    args: { userId: User['id']; outflow: TurnoverOutflow },
  ): Promise<void> {
    const refused = await this.refusal(tx, args);
    if (refused) {
      throw refused;
    }
  }

  async priceAllPending(): Promise<void> {
    if (!this.enabled || !this.deps.rates) {
      return;
    }
    const db = this.deps.drizzle.db;
    const pairs = await db
      .selectDistinct({
        currency: walletTurnoverEntry.currency,
        pivotCurrency: walletTurnover.pivotCurrency,
      })
      .from(walletTurnoverEntry)
      .innerJoin(walletTurnover, eq(walletTurnover.userId, walletTurnoverEntry.userId))
      .where(eq(walletTurnoverEntry.status, 'pending'));
    const rates = new Map<string, string>();
    const priceable: SQL[] = [];
    for (const { currency, pivotCurrency } of pairs) {
      const rate = await this.rate(currency, pivotCurrency, db);
      if (rate !== null) {
        rates.set(rateKey(currency, pivotCurrency), rate);
        priceable.push(sql`(${currency}, ${pivotCurrency})`);
      }
    }
    if (priceable.length === 0) {
      return;
    }
    let after: User['id'] | undefined;
    for (;;) {
      const users = await db
        .selectDistinct({ userId: walletTurnoverEntry.userId })
        .from(walletTurnoverEntry)
        .innerJoin(walletTurnover, eq(walletTurnover.userId, walletTurnoverEntry.userId))
        .where(
          and(
            eq(walletTurnoverEntry.status, 'pending'),
            sql`(${walletTurnoverEntry.currency}, ${walletTurnover.pivotCurrency}) in (${sql.join(priceable, sql`, `)})`,
            after === undefined ? undefined : gt(walletTurnoverEntry.userId, after),
          ),
        )
        .orderBy(walletTurnoverEntry.userId)
        .limit(PRICING_PAGE);
      for (const { userId } of users) {
        try {
          await db.transaction((tx) => this.pricePending(tx, userId, rates));
        } catch (error) {
          this.logger.error(
            { userId, error: error instanceof Error ? error.name : typeof error },
            'turnover pricing failed for a player',
          );
        }
      }
      const last = users.at(-1);
      if (users.length < PRICING_PAGE || last === undefined) {
        return;
      }
      after = last.userId;
    }
  }

  async tracks(tx: unknown, userId: User['id']): Promise<boolean> {
    return (await this.readRow(tx as DrizzleDb, userId)) !== undefined;
  }

  async stakeStamp(
    tx: unknown,
    { userId, product, currency, realPart }: TurnoverStake,
  ): Promise<(TurnoverStakeStamp & { row: TurnoverRow }) | null> {
    if (!this.enabled || product === undefined || !isPositiveMoney(realPart)) {
      return null;
    }
    const db = tx as DrizzleDb;
    const [owed] = await db
      .select({ row: walletTurnover, overrides: walletTurnoverConfig.productPercent })
      .from(walletTurnover)
      .leftJoin(walletTurnoverConfig, eq(walletTurnoverConfig.singletonKey, CONFIG_KEY))
      .where(eq(walletTurnover.userId, userId));
    if (!owed || this.isMet(owed.row)) {
      return null;
    }
    const percent = owed.overrides?.[product] ?? this.deps.config.productPercent[product];
    if (percent === 0) {
      return null;
    }
    const pivotValue = await this.price({
      amount: realPart,
      currency,
      pivotCurrency: owed.row.pivotCurrency,
      tx: db,
    });
    if (pivotValue === null) {
      return null;
    }
    const contribution = moneyMultiplyDivide(pivotValue, String(percent), '100');
    if (!isPositiveMoney(contribution)) {
      return null;
    }
    const locked = await this.lockSinceClear(db, userId);
    if (!locked || locked.clearedSinceStart || this.isMet(locked.row)) {
      return null;
    }
    if (this.deps.config.countAtSettle.includes(product)) {
      return { contribution, state: 'deferred', row: locked.row };
    }
    return {
      contribution: this.countable(locked.row, contribution),
      state: 'counted',
      row: locked.row,
    };
  }

  async countStake(
    tx: unknown,
    { row, contribution }: { row: TurnoverRow; contribution: string },
  ): Promise<void> {
    await this.writeRow(tx as DrizzleDb, row, { progress: moneyAdd(row.progress, contribution) });
  }

  private afterLastClear(userId: User['id']): SQL {
    return sql`${walletTransaction.createdAt} > coalesce((select ${walletTurnover.clearedAt} from ${walletTurnover} where ${walletTurnover.userId} = ${userId}), '-infinity')`;
  }

  private async roundSums(
    db: DrizzleDb,
    userId: User['id'],
    scope: SQL | undefined,
  ): Promise<RoundSums> {
    const t = walletTransaction;
    const isBet = sql`${t.type} = 'bet' and ${t.direction} = 'debit'`;
    const afterClear = this.afterLastClear(userId);
    const [sums] = await db
      .select({
        counted: sql<string>`coalesce(sum(${t.turnoverContribution}) filter (where ${isBet} and ${t.turnoverState} = 'counted' and ${afterClear}), 0)`,
        deferred: sql<string>`coalesce(sum(${t.turnoverContribution}) filter (where ${isBet} and ${t.turnoverState} = 'deferred' and ${afterClear}), 0)`,
        reversed: sql<string>`coalesce(sum(${t.turnoverContribution}) filter (where ${t.turnoverState} = 'reversal' and ${afterClear}), 0)`,
        staked: sql<string>`coalesce(sum(${t.amount}) filter (where ${isBet}), 0)`,
      })
      .from(t)
      .where(and(scope, eq(t.status, 'completed')));
    return sums ?? { counted: '0', deferred: '0', reversed: '0', staked: '0' };
  }

  private roundScope({ walletId, currency, providerName, externalRoundId }: TurnoverRound) {
    const t = walletTransaction;
    return and(
      eq(t.walletId, walletId),
      eq(t.providerName, providerName),
      eq(t.externalRoundId, externalRoundId),
      eq(t.currency, currency),
    );
  }

  async settleRound(tx: unknown, round: TurnoverRound): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const db = tx as DrizzleDb;
    if (!(await this.lockRow(db, round.userId))) {
      return;
    }
    const t = walletTransaction;
    const flipped = await db
      .update(t)
      .set({ turnoverState: 'counted' })
      .where(
        and(
          this.roundScope(round),
          eq(t.type, 'bet'),
          eq(t.direction, 'debit'),
          eq(t.turnoverState, 'deferred'),
        ),
      )
      .returning({
        contribution: t.turnoverContribution,
        afterClear: sql<boolean>`${this.afterLastClear(round.userId)}`,
      });
    const settled = flipped
      .filter(({ afterClear }) => afterClear)
      .reduce((sum, row) => moneyAdd(sum, row.contribution ?? '0'), '0');
    if (!isPositiveMoney(settled)) {
      return;
    }
    const { counted, reversed } = await this.roundSums(db, round.userId, this.roundScope(round));
    const delta = moneySubtract(
      maxZero(moneySubtract(counted, reversed)),
      maxZero(moneySubtract(moneySubtract(counted, settled), reversed)),
    );
    if (isPositiveMoney(delta)) {
      await this.moveProgress(db, round.userId, delta);
    }
  }

  async reverseStake(tx: unknown, reversal: TurnoverReversal): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const db = tx as DrizzleDb;
    const locked = await this.lockSinceClear(db, reversal.userId);
    if (!locked || locked.clearedSinceStart) {
      return;
    }
    const t = walletTransaction;
    const { reversesTransactionId, externalRoundId, amount } = reversal;
    const scope =
      externalRoundId === undefined
        ? reversesTransactionId === undefined
          ? undefined
          : and(
              eq(t.walletId, reversal.walletId),
              or(
                eq(t.id, reversesTransactionId),
                eq(t.reversedTransactionId, reversesTransactionId),
              ),
            )
        : this.roundScope({ ...reversal, externalRoundId });
    if (scope === undefined) {
      return;
    }
    const sums = await this.roundSums(db, reversal.userId, scope);
    let share = '0';
    if (reversesTransactionId === undefined) {
      if (isPositiveMoney(sums.staked)) {
        share = moneyMultiplyDivide(moneyAdd(sums.counted, sums.deferred), amount, sums.staked);
      }
    } else {
      const [bet] = await db
        .select({
          amount: t.amount,
          contribution: t.turnoverContribution,
          state: t.turnoverState,
        })
        .from(t)
        .where(
          and(
            eq(t.id, reversesTransactionId),
            eq(t.walletId, reversal.walletId),
            this.afterLastClear(reversal.userId),
          ),
        );
      if (bet?.contribution && bet.state !== 'reversal' && isPositiveMoney(bet.amount)) {
        share = moneyMultiplyDivide(bet.contribution, amount, bet.amount);
      }
    }
    share = minMoney(
      share,
      maxZero(moneySubtract(moneyAdd(sums.counted, sums.deferred), sums.reversed)),
    );
    if (!isPositiveMoney(share)) {
      return;
    }
    await db
      .update(t)
      .set({ turnoverContribution: share, turnoverState: 'reversal' })
      .where(eq(t.id, reversal.ledgerRowId));
    const countedNet = maxZero(moneySubtract(sums.counted, sums.reversed));
    const delta = moneySubtract(
      maxZero(moneySubtract(moneySubtract(sums.counted, sums.reversed), share)),
      countedNet,
    );
    if (moneyCompare(delta, '0') < 0) {
      await this.moveProgress(db, reversal.userId, delta);
    }
  }
}
