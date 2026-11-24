import {
  isPositiveMoney,
  moneyAdd,
  moneyCompare,
  moneyMultiplyDivide,
  moneyScaleBy,
  moneySubtract,
  type DrizzleDb,
  type DrizzleService,
  type EventBus,
} from '@openora/core/server';
import {
  TurnoverDisabledError,
  WAGER_PRODUCTS,
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
  TurnoverConfigView,
  TurnoverEntriesQuery,
  UpdateTurnoverConfigInput,
} from '../contract/index.js';

const CONFIG_KEY = 'global';
const PRICING_PAGE = 500;

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
  /** The credit's ledger row id. */
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
  /** Absent on an fx-less install: every non-pivot credit then stays pending. */
  rates?: ExchangeRateReader;
};

type LedgerRow = typeof walletTransaction.$inferSelect;

export type TurnoverStake = {
  userId: User['id'];
  /** The bet's ledger row, stamped with what it counts. */
  ledgerRowId: LedgerRow['id'];
  product: WagerProduct | undefined;
  currency: string;
  /** The part of the stake the real balance paid. */
  realPart: string;
};

/** A ledger round: one wallet's rows under one provider round id, in one currency. */
export type TurnoverRound = {
  userId: User['id'];
  walletId: LedgerRow['walletId'];
  currency: string;
  providerName: string;
  externalRoundId: string;
};

export type TurnoverReversal = Omit<TurnoverRound, 'externalRoundId'> & {
  externalRoundId: string | undefined;
  /** The reversal's own ledger row. */
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
  constructor(private readonly deps: TurnoverServiceDeps) {}

  get enabled(): boolean {
    return moneyCompare(this.deps.config.multiplier, '0') > 0;
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

  /** Nothing owed: what is left is at most dust and no entry waits for a rate. */
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
      locked: moneyCompare(remaining, this.deps.config.dustThreshold) > 0 || row.pendingCount > 0,
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

  private async entryRows(
    userId: User['id'],
    { cursor, limit }: TurnoverEntriesQuery,
  ): Promise<{ rows: EntryRow[]; nextCursor: string | null }> {
    if (!this.enabled) {
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

  async entries(
    userId: User['id'],
    query: TurnoverEntriesQuery,
  ): Promise<{ items: TurnoverEntry[]; nextCursor: string | null }> {
    const { rows, nextCursor } = await this.entryRows(userId, query);
    return { items: rows.map(toEntry), nextCursor };
  }

  async adminEntries(
    userId: User['id'],
    query: TurnoverEntriesQuery,
  ): Promise<{ items: AdminTurnoverEntry[]; nextCursor: string | null }> {
    const { rows, nextCursor } = await this.entryRows(userId, query);
    return { items: rows.map(toAdminEntry), nextCursor };
  }

  /** Zeroes the player's requirement and clears every live entry; a no-op when nothing is owed. */
  async clear(
    adminId: User['id'],
    { userId, reason }: { userId: User['id']; reason: string },
    meta?: ClientMeta,
  ): Promise<{ cleared: boolean; summary: TurnoverSummary }> {
    return this.deps.drizzle.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(walletTurnover)
        .where(eq(walletTurnover.userId, userId))
        .for('update');
      const live = await tx
        .select({ id: walletTurnoverEntry.id })
        .from(walletTurnoverEntry)
        .where(
          and(
            eq(walletTurnoverEntry.userId, userId),
            inArray(walletTurnoverEntry.status, ['counted', 'pending']),
          ),
        )
        .orderBy(walletTurnoverEntry.id)
        .for('update');
      const owes =
        row !== undefined &&
        (moneyCompare(row.required, '0') !== 0 ||
          moneyCompare(row.progress, '0') !== 0 ||
          row.pendingCount > 0 ||
          live.length > 0);
      if (!owes) {
        return { cleared: false, summary: await this.summary(userId, tx) };
      }
      const before = this.toSummary(row);
      const now = new Date();
      const entryIds = live.map((entry) => entry.id);
      const [updated] = await tx
        .update(walletTurnover)
        .set({ required: '0', progress: '0', pendingCount: 0, clearedAt: now })
        .where(eq(walletTurnover.userId, userId))
        .returning();
      if (entryIds.length > 0) {
        await tx
          .update(walletTurnoverEntry)
          .set({ status: 'cleared', clearedAt: now, clearedBy: adminId, clearReason: reason })
          .where(inArray(walletTurnoverEntry.id, entryIds));
      }
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
          entryIds,
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

  /** The pivot value of `amount`, or null while no rate is available. */
  private async price(
    amount: string,
    currency: string,
    pivotCurrency: string,
    tx: unknown,
  ): Promise<string | null> {
    if (currency.toUpperCase() === pivotCurrency) {
      return amount;
    }
    return (await this.deps.rates?.convert(amount, currency, pivotCurrency, tx)) ?? null;
  }

  private async findEntry(
    db: DrizzleDb,
    source: TurnoverEntrySource,
    sourceRef: string,
  ): Promise<AddTurnoverRequirementResult | null> {
    const [existing] = await db
      .select({ id: walletTurnoverEntry.id, status: walletTurnoverEntry.status })
      .from(walletTurnoverEntry)
      .where(
        and(eq(walletTurnoverEntry.source, source), eq(walletTurnoverEntry.sourceRef, sourceRef)),
      );
    return existing ? { entryId: existing.id, status: existing.status, replayed: true } : null;
  }

  private async lockRow(db: DrizzleDb, userId: User['id']): Promise<TurnoverRow | undefined> {
    const [row] = await db
      .select()
      .from(walletTurnover)
      .where(eq(walletTurnover.userId, userId))
      .for('update');
    return row;
  }

  private async readRow(db: DrizzleDb, userId: User['id']): Promise<TurnoverRow | undefined> {
    const [row] = await db.select().from(walletTurnover).where(eq(walletTurnover.userId, userId));
    return row;
  }

  /**
   * Writes the locked row's new values and emits `wallet.turnover.met` when this write is the one
   * that meets the requirement. The row lock makes that transition visible to one writer only.
   */
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

  /** Moves the player's progress by `delta` under the row lock, never below zero. */
  private async moveProgress(db: DrizzleDb, userId: User['id'], delta: string): Promise<void> {
    const row = await this.lockRow(db, userId);
    if (!row) {
      return;
    }
    await this.writeRow(db, row, { progress: maxZero(moneyAdd(row.progress, delta)) });
  }

  /**
   * Adds one entry's requirement on the caller's transaction, deduplicated on `(source, sourceRef)`.
   * Prices before it takes the player's turnover row lock, then locks that row before the entry.
   */
  private async addEntry(tx: unknown, entry: NewEntry): Promise<AddTurnoverRequirementResult> {
    const db = tx as DrizzleDb;
    const replay = await this.findEntry(db, entry.source, entry.sourceRef);
    if (replay) {
      return replay;
    }
    const pivotCurrency =
      (await this.readRow(db, entry.userId))?.pivotCurrency ?? this.deps.pivotCurrency;
    const pivotValue = await this.price(entry.amount, entry.currency, pivotCurrency, tx);
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
      const existing = await this.findEntry(db, entry.source, entry.sourceRef);
      if (!existing) {
        throw new Error('turnover entry missing after its conflict');
      }
      return existing;
    }
    // Play past a met requirement is not banked; while anything is owed, play already counted stays.
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
    return this.addEntry(tx, {
      userId,
      source,
      sourceRef,
      currency,
      amount: requiredInCurrency,
      multiplier: '1',
    });
  }

  /**
   * The requirement a credit owes, added on the caller's transaction once per `sourceRef` (its
   * ledger row id). Touches nothing while turnover is off or `kind` is not in `creditTypes`. The
   * caller already holds the wallet, balance and grant locks it takes, never takes them after.
   */
  async addCredit(
    tx: unknown,
    { kind, ...credit }: TurnoverCredit,
  ): Promise<AddTurnoverRequirementResult | null> {
    if (!this.enabled || !this.deps.config.creditTypes.includes(kind)) {
      return null;
    }
    return this.addEntry(tx, { ...credit, source: kind, multiplier: this.deps.config.multiplier });
  }

  /**
   * Prices the player's pending entries that have a rate now, then applies them under the turnover
   * row lock. Only an entry this call moves out of `pending` adds to `required`, so a repeat or a
   * concurrent run adds nothing twice. Returns how many it priced.
   */
  async pricePending(tx: unknown, userId: User['id']): Promise<number> {
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
    const quotes: { id: string; pivotValue: string; required: string }[] = [];
    for (const entry of pending) {
      const pivotValue = await this.price(entry.amount, entry.currency, current.pivotCurrency, db);
      if (pivotValue !== null) {
        quotes.push({
          id: entry.id,
          pivotValue,
          required: moneyScaleBy(pivotValue, entry.multiplier),
        });
      }
    }
    if (quotes.length === 0) {
      return 0;
    }
    const row = await this.lockRow(db, userId);
    if (!row) {
      return 0;
    }
    let added = '0';
    let priced = 0;
    for (const { id, pivotValue, required } of quotes) {
      const [updated] = await db
        .update(walletTurnoverEntry)
        .set({ status: 'counted', pivotValue, required, pricedAt: new Date() })
        .where(and(eq(walletTurnoverEntry.id, id), eq(walletTurnoverEntry.status, 'pending')))
        .returning({ id: walletTurnoverEntry.id });
      if (updated) {
        added = moneyAdd(added, required);
        priced += 1;
      }
    }
    if (priced > 0) {
      await this.writeRow(db, row, {
        required: moneyAdd(row.required, added),
        pendingCount: Math.max(row.pendingCount - priced, 0),
      });
    }
    return priced;
  }

  /** The pricing job: one transaction per player with a pending entry, so no lock outlives its player. */
  async priceAllPending(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const db = this.deps.drizzle.db;
    let after: User['id'] | undefined;
    for (;;) {
      const users = await db
        .selectDistinct({ userId: walletTurnoverEntry.userId })
        .from(walletTurnoverEntry)
        .where(
          and(
            eq(walletTurnoverEntry.status, 'pending'),
            after === undefined ? undefined : gt(walletTurnoverEntry.userId, after),
          ),
        )
        .orderBy(walletTurnoverEntry.userId)
        .limit(PRICING_PAGE);
      for (const { userId } of users) {
        await db.transaction((tx) => this.pricePending(tx, userId));
      }
      const last = users.at(-1);
      if (users.length < PRICING_PAGE || last === undefined) {
        return;
      }
      after = last.userId;
    }
  }

  private async productPercent(product: WagerProduct, db: DrizzleDb): Promise<number> {
    return (await this.overrides(db))[product] ?? this.deps.config.productPercent[product];
  }

  private stamp(
    db: DrizzleDb,
    ledgerRowId: LedgerRow['id'],
    contribution: string,
    state: NonNullable<LedgerRow['turnoverState']>,
  ) {
    return db
      .update(walletTransaction)
      .set({ turnoverContribution: contribution, turnoverState: state })
      .where(eq(walletTransaction.id, ledgerRowId));
  }

  /**
   * Counts a bet's real part on the caller's transaction, after its ledger row is written. Nothing
   * is priced or stamped while nothing is owed. A product in `countAtSettle` is priced and stamped
   * `deferred` here, and counts when its round settles.
   */
  async countStake(
    tx: unknown,
    { userId, ledgerRowId, product, currency, realPart }: TurnoverStake,
  ): Promise<void> {
    if (!this.enabled || product === undefined || !isPositiveMoney(realPart)) {
      return;
    }
    const db = tx as DrizzleDb;
    const owed = await this.readRow(db, userId);
    if (!owed || this.isMet(owed)) {
      return;
    }
    const percent = await this.productPercent(product, db);
    if (percent === 0) {
      return;
    }
    const pivotValue = await this.price(realPart, currency, owed.pivotCurrency, db);
    if (pivotValue === null) {
      return;
    }
    const contribution = moneyMultiplyDivide(pivotValue, String(percent), '100');
    if (!isPositiveMoney(contribution)) {
      return;
    }
    if (this.deps.config.countAtSettle.includes(product)) {
      await this.stamp(db, ledgerRowId, contribution, 'deferred');
      return;
    }
    const row = await this.lockRow(db, userId);
    if (!row || this.isMet(row)) {
      return;
    }
    await this.stamp(db, ledgerRowId, contribution, 'counted');
    await this.writeRow(db, row, { progress: moneyAdd(row.progress, contribution) });
  }

  private async roundSums(db: DrizzleDb, scope: SQL | undefined): Promise<RoundSums> {
    const t = walletTransaction;
    const isBet = sql`${t.type} = 'bet' and ${t.direction} = 'debit'`;
    const [sums] = await db
      .select({
        counted: sql<string>`coalesce(sum(${t.turnoverContribution}) filter (where ${isBet} and ${t.turnoverState} = 'counted'), 0)`,
        deferred: sql<string>`coalesce(sum(${t.turnoverContribution}) filter (where ${isBet} and ${t.turnoverState} = 'deferred'), 0)`,
        reversed: sql<string>`coalesce(sum(${t.turnoverContribution}) filter (where ${t.turnoverState} = 'reversal'), 0)`,
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

  /**
   * The round's final result reached the wallet: its `deferred` stakes count now, net of its
   * reversals. The conditional flip is the guard, so a re-settle after a reopen counts nothing more.
   */
  async settleRound(tx: unknown, round: TurnoverRound): Promise<void> {
    if (!this.enabled || this.deps.config.countAtSettle.length === 0) {
      return;
    }
    const db = tx as DrizzleDb;
    if (!(await this.readRow(db, round.userId))) {
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
      .returning({ contribution: t.turnoverContribution });
    if (flipped.length === 0) {
      return;
    }
    const settled = flipped.reduce((sum, row) => moneyAdd(sum, row.contribution ?? '0'), '0');
    const { counted, reversed } = await this.roundSums(db, this.roundScope(round));
    const delta = moneySubtract(
      maxZero(moneySubtract(counted, reversed)),
      maxZero(moneySubtract(moneySubtract(counted, settled), reversed)),
    );
    if (isPositiveMoney(delta)) {
      await this.moveProgress(db, round.userId, delta);
    }
  }

  /**
   * Takes a stake reversal's share back: the named bet's contribution pro rata to what is
   * reversed, else the round's, capped at what the round still holds. Stamped on the reversal row;
   * progress drops only by the part that had already counted.
   */
  async reverseStake(tx: unknown, reversal: TurnoverReversal): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const db = tx as DrizzleDb;
    if (!(await this.readRow(db, reversal.userId))) {
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
    const sums = await this.roundSums(db, scope);
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
        .where(and(eq(t.id, reversesTransactionId), eq(t.walletId, reversal.walletId)));
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
    await this.stamp(db, reversal.ledgerRowId, share, 'reversal');
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
