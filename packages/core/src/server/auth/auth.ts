import { randomUUID } from 'node:crypto';
import { betterAuth } from 'better-auth';
import type { Auth as BetterAuthType } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization, admin as adminPlugin, twoFactor, emailOTP } from 'better-auth/plugins';
import type { DrizzleDb } from '../db/index.js';
import { ac, roles } from './permissions.js';
import {
  OTP_CODE_LENGTH,
  OTP_EXPIRES_IN_SEC,
  type EmailTemplateRenderer,
} from '@openora/core/contracts';

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
  onPasswordReset?: (user: { id: string; email: string }) => Promise<void> | void;
  templateRenderer?: EmailTemplateRenderer;
  getUserLanguage?: (email: string) => Promise<string | null>;
};

// Used only by SessionResolver's createAuth() call, which never sends email (getSession
// only) - keeps templateRenderer optional on AuthOptions without a server/auth -> pam
// layering violation (the real DefaultEmailTemplateRenderer lives in pam/identity).
const fallbackTemplateRenderer: EmailTemplateRenderer = {
  render: (key, data) =>
    key === 'verifyEmail'
      ? {
          subject: 'Verify your email',
          body: `Verify your email using this link: ${data['url']}\n\nVerification token: ${data['token']}`,
        }
      : { subject: 'Reset your password', body: `Your password reset code is: ${data['otp']}` },
};

/**
 * Builds the one shared better-auth instance for the whole app - both the
 * per-request session middleware and `AdminGuard` resolve sessions through it,
 * never a second `createAuth()` over the same DB. Bundles the org, admin
 * (role/permission), and two-factor plugins; `sendEmail` is a silent no-op
 * when omitted (eg tests) rather than throwing. The explicit `BetterAuthType`
 * return annotation is load-bearing, not stylistic - it dodges a TS2883 Zod v4
 * `$strip` portability error the inferred type would otherwise surface.
 */
export function createAuth(options: AuthOptions): BetterAuthType {
  const sendEmail: SendEmail = options.sendEmail ?? (() => {});
  const templateRenderer = options.templateRenderer ?? fallbackTemplateRenderer;
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
      rememberMeDuration: 30 * 24 * 60 * 60,
      revokeSessionsOnPasswordReset: true,
      onPasswordReset: options.onPasswordReset
        ? async ({ user }) => {
            await options.onPasswordReset?.({ id: user.id, email: user.email });
          }
        : undefined,
    },
    emailVerification: {
      sendVerificationEmail: async ({ user, url, token }) => {
        const locale = (user as { language?: string }).language ?? 'en';
        const { subject, body } = await templateRenderer.render(
          'verifyEmail',
          { url, token },
          locale,
        );
        await sendEmail({ to: user.email, subject, body });
      },
    },
    // Without this, better-auth's admin plugin defaults new signups to its own
    // 'user' role, which UserRoleSchema (player|admin) rejects everywhere downstream.
    plugins: [
      organization(),
      adminPlugin({ ac, roles, defaultRole: 'player' }),
      twoFactor(),
      emailOTP({
        otpLength: OTP_CODE_LENGTH,
        expiresIn: OTP_EXPIRES_IN_SEC,
        async sendVerificationOTP({ email, otp, type }) {
          if (type !== 'forget-password') {
            return;
          }
          const locale = (await options.getUserLanguage?.(email)) ?? 'en';
          const { subject, body } = await templateRenderer.render(
            'resetPasswordOtp',
            { otp },
            locale,
          );
          await sendEmail({ to: email, subject, body });
        },
      }),
    ],
    // Library boundary: better-auth infers an options-specific instantiation that isn't
    // assignable to its own exported `Auth` alias. No way to narrow without matching the
    // full generic - the one sanctioned cast, see conventions.
  }) as unknown as BetterAuthType;
}

export type Auth = BetterAuthType;
