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
    dateOfBirth: date({ mode: 'string' }),
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
    timezone: text(),
    timezoneUpdatedAt: timestamp({ withTimezone: true }),
    termsVersion: text(),
    termsAcceptedAt: timestamp({ withTimezone: true }),
    ageAcceptedAt: timestamp({ withTimezone: true }),
    registrationIp: text(),
    registrationUserAgent: text(),
    hideUsernameOnLeaderboards: boolean().notNull().default(false),
    allowFriendRequests: boolean().notNull().default(true),
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

export const playerAcquisition = pgTable('player_acquisition', {
  id: uuid().primaryKey().defaultRandom(),
  playerId: uuid()
    .notNull()
    .unique('player_acquisition_player_id_unique')
    .references(() => player.id, { onDelete: 'cascade' }),
  params: jsonb().$type<RegistrationAcquisition['params']>().notNull(),
  firstSeenAt: timestamp({ withTimezone: true }),
  landingHost: text(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export type PlayerAcquisition = typeof playerAcquisition.$inferSelect;
