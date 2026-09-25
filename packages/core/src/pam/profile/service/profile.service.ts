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
import { eq } from 'drizzle-orm';
import { player } from '../schema/index.js';
import type {
  UpdatePlayerProfileInput,
  SetDisplayCurrencyInput,
  SetDisplayDecimalPlacesInput,
  DisplayCurrencyInfo,
} from '../contract/index.js';
import { toPlayer, fetchIdentityByUserId } from '../../shared/player-mapper.js';
import { phoneMatchesCountryCallingCode } from './phone-country.js';

export const ProfileUserNotFoundError = makeNotFoundError('User');

export const UnsupportedDisplayCurrencyError = createDomainError<[currency: string]>(
  'UnsupportedDisplayCurrencyError',
  (currency) => `Display currency not supported: ${currency}`,
);

export const PhoneCountryMismatchError = createDomainError<[country: string]>(
  'PhoneCountryMismatchError',
  (country) => `Phone number does not match the calling code for country ${country}`,
  { reason: 'phone_country_mismatch' },
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
   * Stores the IANA zone the browser reported. Display metadata - it never gates anything and
   * stays out of RG windows and audit records, which remain UTC. `timezoneUpdatedAt` moves on
   * every accepted capture, including one repeating the stored zone, so it reads as "last
   * confirmed". An unrecognised zone, and a player with no row yet, are both silent no-ops.
   */
  async recordTimezone(userId: User['id'], timezone: string): Promise<void> {
    const resolved = resolveTimezone(timezone);
    if (!resolved) {
      return;
    }
    await this.drizzle.db
      .update(player)
      .set({ timezone: resolved, timezoneUpdatedAt: new Date() })
      .where(eq(player.userId, userId));
  }

  async updateMyProfile(userId: User['id'], data: UpdatePlayerProfileInput) {
    const { timezone, ...fields } = data;
    const identity = await fetchIdentityByUserId(this.drizzle, userId);
    if (!identity) {
      throw new ProfileUserNotFoundError(userId);
    }

    const record = await this.drizzle.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(player)
        .where(eq(player.userId, userId))
        .limit(1)
        .for('update');
      let row = locked;
      if (!row) {
        const [created] = await tx
          .insert(player)
          .values({ userId })
          .onConflictDoUpdate({ target: player.userId, set: { userId } })
          .returning();
        if (!created) {
          throw new Error('Profile upsert returned no row');
        }
        row = created;
      }

      if ('phone' in fields || 'country' in fields) {
        const effectivePhone = 'phone' in fields ? fields.phone : row.phone;
        const effectiveCountry = 'country' in fields ? fields.country : row.country;
        if (
          effectivePhone &&
          effectiveCountry &&
          !phoneMatchesCountryCallingCode(effectivePhone, effectiveCountry)
        ) {
          throw new PhoneCountryMismatchError(effectiveCountry);
        }
      }

      const resolvedTimezone = timezone === undefined ? undefined : resolveTimezone(timezone);
      const updates = {
        ...fields,
        ...(resolvedTimezone ? { timezone: resolvedTimezone, timezoneUpdatedAt: new Date() } : {}),
      };
      if (!Object.keys(updates).length) {
        return row;
      }

      const [updated] = await tx
        .update(player)
        .set(updates)
        .where(eq(player.userId, userId))
        .returning();
      if (!updated) {
        throw new Error('Profile update returned no row');
      }
      return updated;
    });
    return toPlayer(record, identity.email, identity.username);
  }

  async getMyDisplayCurrency(userId: User['id']): Promise<DisplayCurrencyInfo> {
    const { row } = await this.ensureProfileRow(userId);
    return {
      currency: await this.resolveEffectiveDisplayCurrency(userId, row),
      supported: [...this.supportedDisplayCurrencies],
      decimalPlaces: row.displayDecimalPlaces,
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

    return {
      currency: input.currency,
      supported: [...this.supportedDisplayCurrencies],
      decimalPlaces: row.displayDecimalPlaces,
    };
  }

  async setMyDisplayDecimalPlaces(
    userId: User['id'],
    input: SetDisplayDecimalPlacesInput,
  ): Promise<DisplayCurrencyInfo> {
    await this.ensureProfileRow(userId);

    // The row is locked before `before` is read, so two racing picks each audit the value
    // they actually replaced; the write and its record commit together or not at all.
    const row = await this.drizzle.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(player)
        .where(eq(player.userId, userId))
        .limit(1)
        .for('update');
      if (!locked) {
        throw new ProfileUserNotFoundError(userId);
      }

      await tx
        .update(player)
        .set({ displayDecimalPlaces: input.decimalPlaces })
        .where(eq(player.id, locked.id));

      await this.audit.recordInTransaction(tx, {
        actorId: userId,
        actorType: 'player',
        action: 'player.display_decimal_places.set',
        resourceType: 'player',
        resourceId: locked.id,
        before: { displayDecimalPlaces: locked.displayDecimalPlaces },
        after: { displayDecimalPlaces: input.decimalPlaces },
      });
      return { ...locked, displayDecimalPlaces: input.decimalPlaces };
    });

    return {
      currency: await this.resolveEffectiveDisplayCurrency(userId, row),
      supported: [...this.supportedDisplayCurrencies],
      decimalPlaces: row.displayDecimalPlaces,
    };
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
