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
    advanced: {
      database: {
        generateId: () => randomUUID(),
      },
    },
    session: {
      expiresIn: 30 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
    },
    user: {
      // Surfaces `theme`/`language` on the session/`me` user and lets `updateUser`
      // write them, so every user (player + admin) syncs a UI theme + locale. Both
      // are validated at the route (theme against the enum, language against
      // PlatformConfig.supportedLanguages).
      additionalFields: {
        theme: { type: 'string', required: false, input: true, defaultValue: 'system' },
        language: { type: 'string', required: false, input: true, defaultValue: 'en' },
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
    // Without this, better-auth's admin plugin defaults new signups to its own
    // 'user' role, which UserRoleSchema (player|admin) rejects everywhere downstream.
    plugins: [organization(), adminPlugin({ ac, roles, defaultRole: 'player' }), twoFactor()],
    // Library boundary: better-auth infers an options-specific instantiation that isn't
    // assignable to its own exported `Auth` alias. No way to narrow without matching the
    // full generic - the one sanctioned cast, see conventions.
  }) as unknown as BetterAuthType;
}

export type Auth = BetterAuthType;
