import { sql } from 'drizzle-orm';
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  boolean,
  timestamp,
  index,
  integer,
} from 'drizzle-orm/pg-core';
import { THEMES } from '@blurifycom/core/contracts';

export const userThemeEnum = pgEnum('user_theme', THEMES);

export const user = pgTable(
  'user',
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    email: text().notNull().unique(),
    emailVerified: boolean().notNull().default(false),
    image: text(),
    theme: userThemeEnum().notNull().default('system'),
    language: text().notNull().default('en'),
    role: text().notNull().default('player'),
    isActive: boolean().notNull().default(true),
    banned: boolean().default(false),
    banReason: text(),
    banExpires: timestamp({ withTimezone: true }),
    // Required by the drizzle adapter when better-auth twoFactor() plugin is enabled.
    // Use logical JS property names only; drizzle.config.ts maps camelCase -> snake_case
    // for SQL identifiers so migrations and runtime are consistent.
    twoFactorEnabled: boolean().default(false),
    failedLoginAttempts: integer().notNull().default(0),
    lockoutUntil: timestamp({ withTimezone: true }),
    // Responsible-Gambling login block (cooling-off / self-exclusion). Written only via
    // the LOGIN_ENFORCEMENT port. `rgBlockedUntil` null while blocked = indefinite
    // (self-exclusion); a Date is the cooling-off expiry the login gate auto-clears.
    rgBlocked: boolean().notNull().default(false),
    rgBlockedUntil: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  // Trigram GIN index so the back-office player search (`ILIKE '%term%'` on email)
  // is index-backed instead of a seq scan. Requires the pg_trgm extension.
  (t) => [index('user_email_trgm_idx').using('gin', sql`${t.email} gin_trgm_ops`)],
);

export const session = pgTable(
  'session',
  {
    id: uuid().primaryKey().defaultRandom(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    token: text().notNull().unique(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .$onUpdateFn(() => new Date()),
    ipAddress: text(),
    userAgent: text(),
    userId: uuid()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (t) => [index('session_user_id_idx').on(t.userId)],
);

export const account = pgTable(
  'account',
  {
    id: uuid().primaryKey().defaultRandom(),
    accountId: text().notNull(),
    providerId: text().notNull(),
    userId: uuid()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: timestamp({ withTimezone: true }),
    refreshTokenExpiresAt: timestamp({ withTimezone: true }),
    scope: text(),
    password: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [index('account_user_id_idx').on(t.userId)],
);

export const verification = pgTable(
  'verification',
  {
    id: uuid().primaryKey().defaultRandom(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
);

// Field shape mirrors better-auth twoFactor() plugin schema. See @blurifycom/core/server createAuth().
export const twoFactor = pgTable(
  'two_factor',
  {
    id: uuid().primaryKey().defaultRandom(),
    secret: text().notNull(),
    backupCodes: text().notNull(),
    userId: uuid()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    verified: boolean().default(true),
  },
  (t) => [
    index('two_factor_user_id_idx').on(t.userId),
    index('two_factor_secret_idx').on(t.secret),
  ],
);

export type User = typeof user.$inferSelect;
export type Session = typeof session.$inferSelect;
export type Account = typeof account.$inferSelect;
export type Verification = typeof verification.$inferSelect;
export type TwoFactor = typeof twoFactor.$inferSelect;
