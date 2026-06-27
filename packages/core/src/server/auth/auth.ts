import { randomUUID } from 'node:crypto';
import { betterAuth } from 'better-auth';
import type { Auth as BetterAuthType } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization, admin as adminPlugin, twoFactor } from 'better-auth/plugins';
import type { DrizzleDb } from '../db/index.js';
import { ac, roles } from './permissions.js';

// Transport-agnostic mail hook; identity plugin binds the implementation via
// NOTIFICATION_DELIVERY_ADAPTER. When omitted, emails are silently skipped (eg in tests).
export type SendEmail = (args: {
  to: string;
  subject: string;
  body: string;
}) => Promise<void> | void;

export type AuthOptions = {
  db: DrizzleDb;
  schema?: Record<string, unknown>;
  sendEmail?: SendEmail;
};

// Explicit return type avoids TS2883 (Zod v4 $strip portability issue with admin plugin).
export function createAuth(options: AuthOptions): BetterAuthType {
  const sendEmail: SendEmail = options.sendEmail ?? (() => {});
  return betterAuth({
    database: drizzleAdapter(options.db, {
      provider: 'pg',
      schema: options.schema,
    }),
    // id columns are `text` without a DB default, so better-auth must supply the value.
    advanced: {
      database: {
        generateId: () => randomUUID(),
      },
    },
    session: {
      expiresIn: 30 * 24 * 60 * 60, // 30 days in seconds
      updateAge: 24 * 60 * 60, // 1 day
    },
    emailAndPassword: {
      enabled: true,
      rememberMeDuration: 30 * 24 * 60 * 60, // 30 days in seconds
      sendResetPassword: async ({ user, url, token }) => {
        await sendEmail({
          to: user.email,
          subject: 'Reset your password',
          body: `Reset your password using this link: ${url}\n\nReset token: ${token}`,
        });
      },
    },
    emailVerification: {
      sendVerificationEmail: async ({ user, url, token }) => {
        await sendEmail({
          to: user.email,
          subject: 'Verify your email',
          body: `Verify your email using this link: ${url}\n\nVerification token: ${token}`,
        });
      },
    },
    plugins: [organization(), adminPlugin({ ac, roles }), twoFactor()],
  }) as unknown as BetterAuthType;
}

export type Auth = BetterAuthType;
