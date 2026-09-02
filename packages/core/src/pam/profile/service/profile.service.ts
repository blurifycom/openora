import {
  DrizzleService,
  makeNotFoundError,
  createDomainError,
  moneyCompare,
} from '@openora/core/server';
import type {
  PlayerProvisioning,
  PlayerRegistrationRecord,
  User,
  WalletReader,
  WalletBalanceReading,
  ExchangeRateReader,
  AuditWritePort,
} from '@openora/core/contracts';
import { resolveTimezone } from '@openora/core/contracts';
import { and, eq, isNull, ne, or } from 'drizzle-orm';
import { player } from '../schema/index.js';
import type {
  UpdatePlayerProfileInput,
  SetDisplayCurrencyInput,
  DisplayCurrencyInfo,
} from '../contract/index.js';
import { toPlayer, fetchIdentityByUserId } from '../../shared/player-mapper.js';

export const ProfileUserNotFoundError = makeNotFoundError('User');

export const UnsupportedDisplayCurrencyError = createDomainError<[currency: string]>(
  'UnsupportedDisplayCurrencyError',
  (currency) => `Display currency not supported: ${currency}`,
);

const VALUE_COMPARISON_CURRENCY = 'USD';

export class ProfileService implements PlayerProvisioning {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly walletReader: WalletReader,
    private readonly exchangeRateReader: ExchangeRateReader,
    private readonly audit: AuditWritePort,
    private readonly supportedDisplayCurrencies: readonly string[],
  ) {}

  /** Idempotent: a retried registration never overwrites the original consent record. */
  async createForRegistration({ userId, ...consent }: PlayerRegistrationRecord) {
    const [inserted] = await this.drizzle.db
      .insert(player)
      .values({ userId, ...consent })
      .onConflictDoNothing({ target: player.userId })
      .returning({ id: player.id });
    return inserted ? { created: true, playerId: inserted.id } : { created: false };
  }

  /**
   * `player.user_id` carries no foreign key (cross-module FKs are not allowed), so the
   * identity row is resolved first: materialising a profile for a missing user would
   * create an orphan that every downstream join then has to defend against.
   */
  private async ensureProfileRow(userId: User['id']) {
    const identity = await fetchIdentityByUserId(this.drizzle, userId);
    if (!identity) {
      throw new ProfileUserNotFoundError(userId);
    }

    const [existing] = await this.drizzle.db.select().from(player).where(eq(player.userId, userId));
    if (existing) {
      return { row: existing, identity };
    }

    // Upsert: a concurrent first-hit may insert the row between our select and
    // this insert. The no-op set makes the conflict path return the winning row
    // without overwriting it, so we always get exactly one row back.
    const [created] = await this.drizzle.db
      .insert(player)
      .values({ userId })
      .onConflictDoUpdate({ target: player.userId, set: { userId } })
      .returning();
    return { row: created, identity };
  }

  private async ensureProfile(userId: User['id']) {
    const { row, identity } = await this.ensureProfileRow(userId);
    return toPlayer(row, identity.email, identity.username);
  }

  async getMyProfile(userId: User['id']) {
    return this.ensureProfile(userId);
  }

  /**
   * Stores the IANA zone the browser reported, for rendering a stored UTC timestamp on the
   * player's own clock. Display metadata only - device-reported and spoofable, so it is
   * never evidence of where the player is, never gates anything, and deliberately stays out
   * of responsible-gambling windows and audit records, which remain UTC.
   *
   * Silent about both of its no-ops, by design. A zone the runtime's tz database does not
   * recognise is dropped rather than stored as arbitrary client text, and the `WHERE` skips
   * the write entirely when the stored zone already matches - a remembered browser signs in
   * with the same zone for months and must not churn `timezoneUpdatedAt` each time. Doing
   * both in the one statement leaves no read-modify-write window for concurrent sessions.
   *
   * A player with no row yet is also a no-op: registration is what materialises the row, and
   * a capture is not a good enough reason to conjure one from a login.
   */
  async recordTimezone(userId: User['id'], timezone: string): Promise<void> {
    const resolved = resolveTimezone(timezone);
    if (!resolved) {
      return;
    }
    await this.drizzle.db
      .update(player)
      .set({ timezone: resolved, timezoneUpdatedAt: new Date() })
      .where(
        and(
          eq(player.userId, userId),
          // `ne` alone is NULL - and so never true - for a player who has never sent one.
          or(isNull(player.timezone), ne(player.timezone, resolved)),
        ),
      );
  }

  async updateMyProfile(userId: User['id'], data: UpdatePlayerProfileInput) {
    // The zone is not a plain profile field: it carries its own validation and its own
    // timestamp, and an unrecognised value is dropped rather than failing the update.
    const { timezone, ...fields } = data;
    const { email, username } = await this.ensureProfile(userId);
    if (timezone !== undefined) {
      await this.recordTimezone(userId, timezone);
    }
    // An update carrying nothing but the zone has no fields left to set, and drizzle
    // rejects an empty `set` - read the row back instead.
    const [record] = Object.keys(fields).length
      ? await this.drizzle.db
          .update(player)
          .set(fields)
          .where(eq(player.userId, userId))
          .returning()
      : await this.drizzle.db.select().from(player).where(eq(player.userId, userId));
    return toPlayer(record, email, username);
  }

  async getMyDisplayCurrency(userId: User['id']): Promise<DisplayCurrencyInfo> {
    const { row } = await this.ensureProfileRow(userId);
    return {
      currency: await this.resolveEffectiveDisplayCurrency(userId, row),
      supported: [...this.supportedDisplayCurrencies],
    };
  }

  async setMyDisplayCurrency(
    userId: User['id'],
    input: SetDisplayCurrencyInput,
  ): Promise<DisplayCurrencyInfo> {
    if (!this.supportedDisplayCurrencies.includes(input.currency)) {
      throw new UnsupportedDisplayCurrencyError(input.currency);
    }

    const { row } = await this.ensureProfileRow(userId);
    const before = row.displayCurrency;

    // One transaction: a display-currency change without its audit record is an
    // unexplained change, so the write and the record commit together or not at all.
    await this.drizzle.db.transaction(async (tx) => {
      await tx
        .update(player)
        .set({ displayCurrency: input.currency })
        .where(eq(player.userId, userId));

      await this.audit.recordInTransaction(tx, {
        actorId: userId,
        actorType: 'player',
        action: 'player.display_currency.set',
        resourceType: 'player',
        resourceId: row.id,
        before: { displayCurrency: before },
        after: { displayCurrency: input.currency },
      });
    });

    return { currency: input.currency, supported: [...this.supportedDisplayCurrencies] };
  }

  private async resolveEffectiveDisplayCurrency(
    userId: User['id'],
    row: { displayCurrency: string | null },
  ): Promise<string> {
    if (row.displayCurrency) {
      return row.displayCurrency;
    }

    const { activeCurrency, balances } = await this.walletReader.getBalances(userId);
    const mostValuable = await this.mostValuableCurrency(balances);
    return mostValuable ?? activeCurrency;
  }

  private async mostValuableCurrency(balances: WalletBalanceReading[]): Promise<string | null> {
    let best: { currency: string; value: string } | null = null;
    for (const balance of balances) {
      if (moneyCompare(balance.balance, '0') <= 0) {
        continue;
      }
      const converted = await this.exchangeRateReader.convert(
        balance.balance,
        balance.currency,
        VALUE_COMPARISON_CURRENCY,
      );
      if (converted === null) {
        continue;
      }
      if (!best || moneyCompare(converted, best.value) > 0) {
        best = { currency: balance.currency, value: converted };
      }
    }
    return best?.currency ?? null;
  }
}
