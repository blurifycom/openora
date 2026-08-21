import {
  pgTable,
  uuid,
  text,
  integer,
  decimal,
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
    country: text(),
    currency: text().notNull().default('USD'),
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
