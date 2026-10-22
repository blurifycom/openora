import {
  pgTable,
  uuid,
  text,
  integer,
  decimal,
  date,
  timestamp,
  pgEnum,
  index,
  boolean,
  check,
  jsonb,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  PLAYER_STATUSES,
  KYC_STATUSES,
  MAX_DISPLAY_DECIMAL_PLACES,
  type RegistrationAcquisition,
} from '@openora/core/contracts';

export const playerStatusEnum = pgEnum('player_status', PLAYER_STATUSES);
export const kycStatusEnum = pgEnum('kyc_status', KYC_STATUSES);

export const player = pgTable(
  'player',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull().unique('player_user_id_unique'),
    firstName: text(),
    lastName: text(),
    // `mode: 'string'` keeps a birth date a plain calendar date: the default Date mode
    // round-trips through a timestamp and shifts the day for players east or west of UTC.
    dateOfBirth: date({ mode: 'string' }),
    // Self-declared contact number - deliberately not unique. `user.phoneNumber` is unique
    // because it is a login credential; making this one unique too would turn an optional
    // profile field into a phone-enumeration oracle and let anyone squat a stranger's number.
    phone: text(),
    country: text(),
    bio: text(),
    currency: text().notNull().default('USD'),
    displayCurrency: text(),
    displayDecimalPlaces: integer(),
    status: playerStatusEnum().notNull().default('active'),
    kycStatus: kycStatusEnum().notNull().default('pending'),
    level: integer().notNull().default(1),
    totalWagered: decimal({ precision: 18, scale: 2 }).notNull().default('0'),
    totalDeposits: decimal({ precision: 18, scale: 2 }).notNull().default('0'),
    lastSeenAt: timestamp({ withTimezone: true }),
    // The IANA zone the player's browser last reported; null until a device reports one,
    // never derived from `country` or `registrationIp`.
    timezone: text(),
    // Last confirmed by a device, not last changed: it moves on every accepted capture.
    timezoneUpdatedAt: timestamp({ withTimezone: true }),
    termsVersion: text(),
    termsAcceptedAt: timestamp({ withTimezone: true }),
    ageAcceptedAt: timestamp({ withTimezone: true }),
    registrationIp: text(),
    registrationUserAgent: text(),
    /** Shows "Incognito" in place of this player's username on a public leaderboard (a wager
     * race, say) instead of the platform's own partial masking. Never affects the player's own
     * standing, wagered total, or prize eligibility - only what other players see. */
    hideUsernameOnLeaderboards: boolean().notNull().default(false),
    /** Off refuses new friend requests addressed to this player. A request the player sent
     * themselves, and friendships that already exist, are unaffected. */
    allowFriendRequests: boolean().notNull().default(true),
    /** Off hides this player's online status and last-seen time from their friends. */
    showOnlineStatusToFriends: boolean().notNull().default(true),
    accountManagerId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    index('player_status_idx').on(t.status),
    index('player_created_at_idx').on(t.createdAt),
    index('player_last_seen_at_idx').on(t.lastSeenAt),
    index('player_account_manager_id_idx').on(t.accountManagerId),
    check(
      'player_display_decimal_places_range',
      sql`${t.displayDecimalPlaces} BETWEEN 0 AND ${sql.raw(String(MAX_DISPLAY_DECIMAL_PLACES))}`,
    ),
  ],
);

export type Player = typeof player.$inferSelect;

/** Written once, with the registration consent; never updated. */
export const playerAcquisition = pgTable(
  'player_acquisition',
  {
    id: uuid().primaryKey().defaultRandom(),
    playerId: uuid()
      .notNull()
      .unique('player_acquisition_player_id_unique')
      .references(() => player.id, { onDelete: 'cascade' }),
    params: jsonb().$type<RegistrationAcquisition['params']>().notNull(),
    firstSeenAt: timestamp({ withTimezone: true }),
    landingHost: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('player_acquisition_params_idx').using('gin', t.params)],
);

export type PlayerAcquisition = typeof playerAcquisition.$inferSelect;
