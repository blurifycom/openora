import {
  moneyAdd,
  moneyCompare,
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
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import * as z from 'zod';
import { walletTurnover, walletTurnoverConfig, walletTurnoverEntry } from '../schema/index.js';
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

const maxZero = (amount: string): string => (moneyCompare(amount, '0') > 0 ? amount : '0');

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

  private toSummary(row: typeof walletTurnover.$inferSelect): TurnoverSummary {
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

  /**
   * Adds one entry's requirement on the caller's transaction, deduplicated on `(source, sourceRef)`.
   * Locks the player's turnover row before the entry, as every turnover writer does.
   */
  private async addEntry(tx: unknown, entry: NewEntry): Promise<AddTurnoverRequirementResult> {
    const db = tx as DrizzleDb;
    const replay = await this.findEntry(db, entry.source, entry.sourceRef);
    if (replay) {
      return replay;
    }
    await db
      .insert(walletTurnover)
      .values({ userId: entry.userId, pivotCurrency: this.deps.pivotCurrency })
      .onConflictDoNothing({ target: walletTurnover.userId });
    const [row] = await db
      .select()
      .from(walletTurnover)
      .where(eq(walletTurnover.userId, entry.userId))
      .for('update');
    if (!row) {
      throw new Error('turnover row missing after its upsert');
    }
    const requiredInCurrency = moneyScaleBy(entry.amount, entry.multiplier);
    const pivotValue = await this.price(entry.amount, entry.currency, row.pivotCurrency, tx);
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
    // Play past a met requirement is not banked: a new credit starts from progress = required.
    const progress = moneyCompare(row.progress, row.required) > 0 ? row.required : row.progress;
    await db
      .update(walletTurnover)
      .set(
        required === null
          ? { progress, pendingCount: row.pendingCount + 1 }
          : { progress, required: moneyAdd(row.required, required) },
      )
      .where(eq(walletTurnover.userId, entry.userId));
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
   * Prices the player's pending entries that have a rate now, under their turnover row lock. Only
   * an entry this call moves out of `pending` adds to `required`, so a repeat or a concurrent run
   * adds nothing twice. Returns how many it priced.
   */
  async pricePending(tx: unknown, userId: User['id']): Promise<number> {
    const db = tx as DrizzleDb;
    const [row] = await db
      .select()
      .from(walletTurnover)
      .where(eq(walletTurnover.userId, userId))
      .for('update');
    if (!row) {
      return 0;
    }
    const pending = await db
      .select()
      .from(walletTurnoverEntry)
      .where(and(eq(walletTurnoverEntry.userId, userId), eq(walletTurnoverEntry.status, 'pending')))
      .orderBy(walletTurnoverEntry.id);
    let added = '0';
    let priced = 0;
    for (const entry of pending) {
      const pivotValue = await this.price(entry.amount, entry.currency, row.pivotCurrency, db);
      if (pivotValue === null) {
        continue;
      }
      const required = moneyScaleBy(pivotValue, entry.multiplier);
      const [updated] = await db
        .update(walletTurnoverEntry)
        .set({ status: 'counted', pivotValue, required, pricedAt: new Date() })
        .where(and(eq(walletTurnoverEntry.id, entry.id), eq(walletTurnoverEntry.status, 'pending')))
        .returning({ id: walletTurnoverEntry.id });
      if (updated) {
        added = moneyAdd(added, required);
        priced += 1;
      }
    }
    if (priced > 0) {
      await db
        .update(walletTurnover)
        .set({
          required: moneyAdd(row.required, added),
          pendingCount: Math.max(row.pendingCount - priced, 0),
        })
        .where(eq(walletTurnover.userId, userId));
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
}
