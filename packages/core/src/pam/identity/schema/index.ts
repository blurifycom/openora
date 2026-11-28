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
import {
  AUTO_LOGOUT_DURATIONS,
  THEMES,
  TWO_FACTOR_DELIVERY_METHODS,
} from '@openora/core/contracts';

export const userThemeEnum = pgEnum('user_theme', THEMES);
export const twoFactorMethodEnum = pgEnum('two_factor_method', TWO_FACTOR_DELIVERY_METHODS);
export const autoLogoutDurationEnum = pgEnum('auto_logout_duration', AUTO_LOGOUT_DURATIONS);

export const user = pgTable(
  'user',
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    username: text().notNull(),
    email: text().notNull().unique(),
    registeredEmail: text(),
    emailVerified: boolean().notNull().default(false),
    image: text(),
    theme: userThemeEnum().notNull().default('system'),
    language: text().notNull().default('en'),
    role: text().notNull().default('player'),
    isActive: boolean().notNull().default(true),
    banned: boolean().default(false),
    banReason: text(),
    banExpires: timestamp({ withTimezone: true }),
    playEligibilityVersion: integer().notNull().default(0),
    twoFactorEnabled: boolean().default(false),
    twoFactorMethod: twoFactorMethodEnum(),
    phoneNumber: text().unique(),
    phoneVerified: boolean().notNull().default(false),
    phoneVerifiedAt: timestamp({ withTimezone: true }),
    passwordMeetsPolicy: boolean().notNull().default(false),
    loginWithdrawalAlertsEnabled: boolean().notNull().default(false),
    autoLogoutDuration: autoLogoutDurationEnum().notNull().default('7d'),
    requireTwoFactorOnLogin: boolean().notNull().default(false),
    withdrawalPinHash: text(),
    withdrawalPinSetAt: timestamp({ withTimezone: true }),
    withdrawalPinFailedAttempts: integer().notNull().default(0),
    withdrawalPinLockedUntil: timestamp({ withTimezone: true }),
    antiPhishingCode: text(),
    failedLoginAttempts: integer().notNull().default(0),
    lockoutUntil: timestamp({ withTimezone: true }),
    failedTwoFactorAttempts: integer().notNull().default(0),
    twoFactorLockoutUntil: timestamp({ withTimezone: true }),
    twoFactorLockoutCount: integer().notNull().default(0),
    lastFailedTwoFactorAt: timestamp({ withTimezone: true }),
    lockoutCount: integer().notNull().default(0),
    lastLockoutAt: timestamp({ withTimezone: true }),
    lastFailedLoginAt: timestamp({ withTimezone: true }),
    rgBlocked: boolean().notNull().default(false),
    rgBlockedUntil: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('user_username_unique').on(sql`lower(${t.username})`),
    index('user_email_trgm_idx').using('gin', sql`${t.email} gin_trgm_ops`),
    index('user_username_trgm_idx').using('gin', sql`${t.username} gin_trgm_ops`),
    index('user_created_at_idx').on(t.createdAt),
    index('user_staff_name_idx')
      .on(t.name, t.id)
      .where(sql`${t.role} <> 'player'`),
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
    lastSeenAt: timestamp({ withTimezone: true }).defaultNow(),
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
    failedVerificationCount: integer().notNull().default(0),
    lockedUntil: timestamp({ withTimezone: true }),
  },
  (t) => [
    index('two_factor_user_id_idx').on(t.userId),
    index('two_factor_secret_idx').on(t.secret),
  ],
);

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

export const phoneVerificationSession = pgTable(
  'phone_verification_session',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: 'cascade' }),
    sessionId: uuid()
      .notNull()
      .references(() => session.id, { onDelete: 'cascade' }),
    phone: text().notNull(),
    codeHash: text().notNull(),
    reauthenticatedAt: timestamp({ withTimezone: true }).notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    failedAttempts: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('phone_verification_session_phone_idx').on(t.phone),
    index('phone_verification_session_session_id_idx').on(t.sessionId),
  ],
);

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
export type PhoneVerificationSession = typeof phoneVerificationSession.$inferSelect;
export type Account = typeof account.$inferSelect;
export type Verification = typeof verification.$inferSelect;
export type TwoFactor = typeof twoFactor.$inferSelect;
export type AdminTrustedDevice = typeof adminTrustedDevice.$inferSelect;
