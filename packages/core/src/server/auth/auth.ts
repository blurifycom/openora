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
  DEFAULT_EMAIL_TEMPLATES,
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
  /**
   * Blocks sign-in until the address is verified. Default off: unverified players stay
   * unrestricted while the KYC toggle is off. Operators that need the stricter gate set
   * `registration.requireEmailVerification` in platform config.
   */
  requireEmailVerification?: boolean;
  onExistingUserSignUp?: (user: { id: string; email: string }) => Promise<void> | void;
  cookieDomain?: string;
};

// Used only by SessionResolver's createAuth() call, which never sends email (getSession
// only) - keeps templateRenderer optional on AuthOptions without a server/auth -> pam
// layering violation (the real DefaultEmailTemplateRenderer lives in pam/identity).
// Delegates to the shared DEFAULT_EMAIL_TEMPLATES map (contracts/adapters/email-template.ts)
// so this fallback copy can never drift from DefaultEmailTemplateRenderer's.
const fallbackTemplateRenderer: EmailTemplateRenderer = {
  render: (key, data) => DEFAULT_EMAIL_TEMPLATES[key](data),
};

/**
 * Builds the one shared better-auth instance for the whole app - both the
 * per-request session middleware and `AdminGuard` resolve sessions through it,
 * never a second `createAuth()` over the same DB. Bundles the org, admin
 * (role/permission), and two-factor plugins; `sendEmail` is a silent no-op
 * when omitted (eg tests) rather than throwing. The explicit `BetterAuthType`
 * return annotation is load-bearing, not stylistic - it dodges a TS2883 Zod v4
 * `$strip` portability error the inferred type would otherwise surface.
 *
 * `cookieDomain` (or `AUTH_COOKIE_DOMAIN`) widens the session cookie to a parent
 * domain, so a frontend on `app.example.com` still sends it to an API on
 * `api.example.com`. Left unset the cookie stays host-only, which is correct when
 * both run on one host and is the safer default everywhere else.
 */
export function createAuth(options: AuthOptions): BetterAuthType {
  const sendEmail: SendEmail = options.sendEmail ?? (() => {});
  const templateRenderer = options.templateRenderer ?? fallbackTemplateRenderer;
  const cookieDomain = options.cookieDomain ?? process.env['AUTH_COOKIE_DOMAIN'];
  return betterAuth({
    database: drizzleAdapter(options.db, {
      provider: 'pg',
      schema: options.schema,
    }),
    advanced: {
      database: {
        generateId: () => randomUUID(),
      },
      ...(cookieDomain ? { crossSubDomainCookies: { enabled: true, domain: cookieDomain } } : {}),
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
        username: { type: 'string', required: false, input: true },
        theme: { type: 'string', required: false, input: true, defaultValue: 'system' },
        language: { type: 'string', required: false, input: true, defaultValue: 'en' },
      },
    },
    emailAndPassword: {
      enabled: true,
      // Sign-up never mints a session: better-auth only returns the indistinguishable
      // duplicate-email response when autoSignIn is off (or verification is required,
      // which is now operator-configurable). The session is minted by the OTP
      // verification step instead - see `autoSignInAfterVerification` below.
      autoSignIn: false,
      requireEmailVerification: options.requireEmailVerification ?? false,
      revokeSessionsOnPasswordReset: true,
      onExistingUserSignUp: options.onExistingUserSignUp
        ? async ({ user }) => {
            await options.onExistingUserSignUp?.({ id: user.id, email: user.email });
          }
        : undefined,
      onPasswordReset: options.onPasswordReset
        ? async ({ user }) => {
            await options.onPasswordReset?.({ id: user.id, email: user.email });
          }
        : undefined,
    },
    emailVerification: {
      // The verification OTP is sent by IdentityService.register(), never by better-auth:
      // its sign-up hook fires on the synthetic duplicate-email response too, which would
      // mail a valid code to an existing account's address (takeover).
      sendOnSignUp: false,
      autoSignInAfterVerification: true,
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
          // Allow-list, not a fallback: an OTP type this app never issues (sign-in,
          // change-email) must send nothing rather than borrow another template's copy.
          if (type !== 'email-verification' && type !== 'forget-password') {
            return;
          }
          const locale = (await options.getUserLanguage?.(email)) ?? 'en';
          const { subject, body } =
            type === 'email-verification'
              ? await templateRenderer.render('verifyEmail', { otp }, locale)
              : await templateRenderer.render('resetPasswordOtp', { otp, email }, locale);
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
