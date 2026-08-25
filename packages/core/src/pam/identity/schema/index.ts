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
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { THEMES } from '@openora/core/contracts';

export const userThemeEnum = pgEnum('user_theme', THEMES);

export const user = pgTable(
  'user',
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    username: text().notNull(),
    email: text().notNull().unique(),
    emailVerified: boolean().notNull().default(false),
    image: text(),
    theme: userThemeEnum().notNull().default('system'),
    language: text().notNull().default('en'),
    role: text().notNull().default('player'),
    isActive: boolean().notNull().default(true),
    // Required by the drizzle adapter when better-auth admin() plugin is enabled;
    // omitting these causes "field banned does not exist" on user creation.
    banned: boolean().default(false),
    banReason: text(),
    banExpires: timestamp({ withTimezone: true }),
    // Required by the drizzle adapter when better-auth twoFactor() plugin is enabled.
    // Use logical JS property names only; drizzle.config.ts maps camelCase -> snake_case
    // for SQL identifiers so migrations and runtime are consistent.
    twoFactorEnabled: boolean().default(false),
    phoneNumber: text().unique(),
    phoneVerified: boolean().notNull().default(false),
    phoneVerifiedAt: timestamp({ withTimezone: true }),
    failedLoginAttempts: integer().notNull().default(0),
    lockoutUntil: timestamp({ withTimezone: true }),
    // Second-factor lockout, counted separately from the password-login columns above:
    // the two thresholds are configured independently and a 2FA lockout must not
    // consume the password-login budget (or vice versa).
    failedTwoFactorAttempts: integer().notNull().default(0),
    twoFactorLockoutUntil: timestamp({ withTimezone: true }),
    twoFactorLockoutCount: integer().notNull().default(0),
    lastFailedTwoFactorAt: timestamp({ withTimezone: true }),
    // Progressive lockout tiers: `lockoutCount` counts lockouts inside a rolling 24h
    // window (reset once `lastLockoutAt` falls outside it), escalating the duration
    // 1min -> 5min -> 15min. Shared by every login method.
    lockoutCount: integer().notNull().default(0),
    lastLockoutAt: timestamp({ withTimezone: true }),
    lastFailedLoginAt: timestamp({ withTimezone: true }),
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
  (t) => [
    uniqueIndex('user_username_unique').on(sql`lower(${t.username})`),
    index('user_email_trgm_idx').using('gin', sql`${t.email} gin_trgm_ops`),
    index('user_username_trgm_idx').using('gin', sql`${t.username} gin_trgm_ops`),
    index('user_created_at_idx').on(t.createdAt),
  ],
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
    // Written by the admin session guard, throttled. better-auth owns `updatedAt` and
    // ties it to its own updateAge bookkeeping, so touching that column to record
    // activity would shift session expiry - this one is ours and better-auth ignores it.
    lastSeenAt: timestamp({ withTimezone: true }),
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

// Field shape mirrors better-auth twoFactor() plugin schema. See @openora/core/server createAuth().
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

// One active OTP per user: `requestOtp` upserts by `userId`, so a new code overwrites the previous one.
// `codeHash` is SHA-256 of the 6-digit code - the plaintext OTP is never stored.
// `failedAttempts` caps guessing at 5 per session.
export const smsOtpSession = pgTable(
  'sms_otp_session',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: 'cascade' }),
    phone: text().notNull(),
    codeHash: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    failedAttempts: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sms_otp_session_phone_idx').on(t.phone)],
);

// Server-side trusted-device registry. better-auth issues its own opaque trust cookie,
// which cannot be listed or revoked; a device only skips the second factor when BOTH
// that cookie and an unrevoked row here are present, so revoking the row forces 2FA on
// the very next request.
export const adminTrustedDevice = pgTable(
  'admin_trusted_device',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    deviceHash: text().notNull(),
    label: text().notNull(),
    ipAddress: text(),
    userAgent: text(),
    lastUsedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
    revokedBy: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('admin_trusted_device_user_hash_idx').on(t.userId, t.deviceHash),
    index('admin_trusted_device_user_id_idx').on(t.userId),
    index('admin_trusted_device_expires_at_idx').on(t.expiresAt),
  ],
);

export type User = typeof user.$inferSelect;
export type Session = typeof session.$inferSelect;
export type SmsOtpSession = typeof smsOtpSession.$inferSelect;
export type Account = typeof account.$inferSelect;
export type Verification = typeof verification.$inferSelect;
export type TwoFactor = typeof twoFactor.$inferSelect;
export type AdminTrustedDevice = typeof adminTrustedDevice.$inferSelect;
