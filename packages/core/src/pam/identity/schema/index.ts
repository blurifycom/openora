import { pgTable, uuid, text, boolean, timestamp, index } from 'drizzle-orm/pg-core';

export const user = pgTable('user', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('emailVerified').notNull().default(false),
  image: text('image'),
  role: text('role').notNull().default('player'),
  isActive: boolean('isActive').notNull().default(true),
  // Required by the drizzle adapter when better-auth admin() plugin is enabled;
  // omitting these causes "field banned does not exist" on user creation.
  banned: boolean('banned').default(false),
  banReason: text('banReason'),
  banExpires: timestamp('banExpires'),
  // Required by the drizzle adapter when better-auth twoFactor() plugin is enabled.
  twoFactorEnabled: boolean('twoFactorEnabled').default(false),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
  updatedAt: timestamp('updatedAt')
    .notNull()
    .$onUpdateFn(() => new Date()),
});

export const session = pgTable(
  'session',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    expiresAt: timestamp('expiresAt').notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
    updatedAt: timestamp('updatedAt')
      .notNull()
      .$onUpdateFn(() => new Date()),
    ipAddress: text('ipAddress'),
    userAgent: text('userAgent'),
    userId: uuid('userId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (t) => [index('session_userId_idx').on(t.userId)],
);

export const account = pgTable(
  'account',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: text('accountId').notNull(),
    providerId: text('providerId').notNull(),
    userId: uuid('userId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('accessToken'),
    refreshToken: text('refreshToken'),
    idToken: text('idToken'),
    accessTokenExpiresAt: timestamp('accessTokenExpiresAt'),
    refreshTokenExpiresAt: timestamp('refreshTokenExpiresAt'),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
    updatedAt: timestamp('updatedAt')
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [index('account_userId_idx').on(t.userId)],
);

export const verification = pgTable(
  'verification',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expiresAt').notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
    updatedAt: timestamp('updatedAt')
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
);

// Field shape mirrors better-auth twoFactor() plugin schema. See @blurifycom/core/server createAuth().
export const twoFactor = pgTable(
  'twoFactor',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    secret: text('secret').notNull(),
    backupCodes: text('backupCodes').notNull(),
    userId: uuid('userId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    verified: boolean('verified').default(true),
  },
  (t) => [index('twoFactor_userId_idx').on(t.userId), index('twoFactor_secret_idx').on(t.secret)],
);

export type User = typeof user.$inferSelect;
export type Session = typeof session.$inferSelect;
export type Account = typeof account.$inferSelect;
export type Verification = typeof verification.$inferSelect;
export type TwoFactor = typeof twoFactor.$inferSelect;
