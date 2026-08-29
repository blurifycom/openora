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
} from 'drizzle-orm/pg-core';
import { PLAYER_STATUSES, KYC_STATUSES } from '@openora/core/contracts';

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
    currency: text().notNull().default('USD'),
    // Player's presentation-only pick for rendering amounts, distinct from `currency`
    // above (the player's operating currency). NULLABLE and NEVER defaulted: `null`
    // means "never chosen" and is a different state from "explicitly chose USD" - see
    // the resolver in service/profile.service.ts, which only falls back to a computed
    // currency when this column is null.
    displayCurrency: text(),
    status: playerStatusEnum().notNull().default('active'),
    kycStatus: kycStatusEnum().notNull().default('pending'),
    level: integer().notNull().default(1),
    totalWagered: decimal({ precision: 18, scale: 2 }).notNull().default('0'),
    totalDeposits: decimal({ precision: 18, scale: 2 }).notNull().default('0'),
    lastSeenAt: timestamp({ withTimezone: true }),
    termsVersion: text(),
    termsAcceptedAt: timestamp({ withTimezone: true }),
    ageAcceptedAt: timestamp({ withTimezone: true }),
    registrationIp: text(),
    registrationUserAgent: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [index('player_status_idx').on(t.status), index('player_created_at_idx').on(t.createdAt)],
);

export type Player = typeof player.$inferSelect;
