import { randomUUID } from 'node:crypto';
import { betterAuth } from 'better-auth';
import type { Auth as BetterAuthType } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization, admin as adminPlugin, twoFactor } from 'better-auth/plugins';
import type { DrizzleDb } from '../db/index.js';
import { ac, roles } from './permissions.js';

// Transport-agnostic mail hook. The identity plugin supplies an implementation
// backed by NOTIFICATION_DELIVERY_ADAPTER; @oss/core/server never imports a mailer or
// the notifications module directly (boundary). When omitted, password-reset /
// verification emails are silently skipped (e.g. in unit tests).
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

// Return type is explicit to avoid TS2883 (Zod v4 $strip portability issue with admin plugin)
export function createAuth(options: AuthOptions): BetterAuthType {
  const sendEmail: SendEmail = options.sendEmail ?? (() => {});
  return betterAuth({
    database: drizzleAdapter(options.db, {
      provider: 'pg',
      schema: options.schema,
    }),
    // Generate UUID ids for every auth model (user/session/account/verification),
    // matching the platform-wide uuid id convention. Our id columns are `text`
    // without a DB default, so better-auth must supply the value itself.
    advanced: {
      database: {
        generateId: () => randomUUID(),
      },
    },
    emailAndPassword: {
      enabled: true,
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
