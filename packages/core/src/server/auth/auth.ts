import { randomUUID } from 'node:crypto';
import { runWithTransaction } from '@better-auth/core/context';
import { betterAuth } from 'better-auth';
import type { Auth as BetterAuthType } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization, admin as adminPlugin, twoFactor, emailOTP } from 'better-auth/plugins';
import type { DrizzleDb, DrizzleTx } from '../db/index.js';
import { ac, roles } from './permissions.js';
import { OTP_CODE_LENGTH, OTP_EXPIRES_IN_SEC, type MailTemplate } from '@openora/core/contracts';

function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const head = local.length > 1 ? local.slice(0, 1) : '';
  return `${head}***@${domain}`;
}

export type DispatchOtpMail = (args: {
  to: string;
  template: MailTemplate;
  recipientName?: string | null;
  antiPhishingCode?: string | null;
}) => Promise<void> | void;

type SendTwoFactorOtp = (args: {
  userId: string;
  email: string;
  phoneNumber: string | null;
  code: string;
}) => Promise<void> | void;

type TwoFactorOptions = {
  trustDeviceMaxAgeSec?: number;
  otpPeriodMinutes?: number;
  sendOtp?: SendTwoFactorOtp;
};

export type AuthOptions = {
  db: DrizzleDb;
  schema?: Record<string, unknown>;
  dispatchOtpMail?: DispatchOtpMail;
  onPasswordReset?: (user: { id: string; email: string }) => Promise<void> | void;
  requireEmailVerification?: boolean;
  onExistingUserSignUp?: (user: { id: string; email: string }) => Promise<void> | void;
  isExistingAccountSignUp?: (email: string) => boolean;
  isAdminPasswordReset?: (email: string) => boolean | Promise<boolean>;
  cookieDomain?: string;
  twoFactor?: TwoFactorOptions;
};

export function createAuth(options: AuthOptions): BetterAuthType {
  const dispatchOtpMail: DispatchOtpMail = options.dispatchOtpMail ?? (() => {});
  const cookieDomain = options.cookieDomain ?? process.env['AUTH_COOKIE_DOMAIN'];

  const auth: BetterAuthType = betterAuth({
    database: drizzleAdapter(options.db, {
      provider: 'pg',
      schema: options.schema,
    }),
    advanced: {
      database: {
        generateId: () => randomUUID(),
        validateSchema: false,
      },
      ...(cookieDomain ? { crossSubDomainCookies: { enabled: true, domain: cookieDomain } } : {}),
    },
    session: {
      expiresIn: 30 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
    },
    user: {
      additionalFields: {
        username: { type: 'string', required: false, input: true },
        theme: { type: 'string', required: false, input: true, defaultValue: 'system' },
        language: { type: 'string', required: false, input: true, defaultValue: 'en' },
        registeredEmail: { type: 'string', required: false, input: false, returned: false },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (u) => ({ data: { registeredEmail: u.email } }),
        },
      },
    },
    emailAndPassword: {
      enabled: true,
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
      sendOnSignUp: false,
      autoSignInAfterVerification: true,
    },
    plugins: [
      organization(),
      adminPlugin({ ac, roles, defaultRole: 'player' }),
      twoFactor({
        ...(options.twoFactor?.trustDeviceMaxAgeSec !== undefined
          ? { trustDeviceMaxAge: options.twoFactor.trustDeviceMaxAgeSec }
          : {}),
        otpOptions: {
          storeOTP: 'hashed',
          ...(options.twoFactor?.otpPeriodMinutes !== undefined
            ? { period: options.twoFactor.otpPeriodMinutes }
            : {}),
          sendOTP: async ({ user, otp }) => {
            await options.twoFactor?.sendOtp?.({
              userId: user.id,
              email: user.email,
              phoneNumber: (user as { phoneNumber?: string | null }).phoneNumber ?? null,
              code: otp,
            });
          },
        },
      }),
      emailOTP({
        otpLength: OTP_CODE_LENGTH,
        expiresIn: OTP_EXPIRES_IN_SEC,
        changeEmail: { enabled: true },
        async sendVerificationOTP({ email, otp, type }, request) {
          if (
            type !== 'email-verification' &&
            type !== 'forget-password' &&
            type !== 'change-email'
          ) {
            return;
          }
          if (type === 'change-email') {
            const session = await auth.api.getSession({
              headers: request?.headers ?? new Headers(),
            });
            if (!session) {
              throw new Error('change-email OTP requested without a resolvable session');
            }
            await dispatchOtpMail({
              to: email,
              template: {
                key: 'emailChangeConfirmation',
                data: { otp, oldEmail: maskEmail(session.user.email), newEmail: email },
              },
            });
            return;
          }
          const template: MailTemplate =
            type === 'email-verification'
              ? { key: 'verifyEmail', data: { otp } }
              : options.isExistingAccountSignUp?.(email)
                ? { key: 'existingAccountSignUp', data: { otp, email } }
                : (await options.isAdminPasswordReset?.(email))
                  ? { key: 'adminResetPasswordOtp', data: { otp, email } }
                  : { key: 'resetPasswordOtp', data: { otp, email } };
          await dispatchOtpMail({ to: email, template });
        },
      }),
    ],
  }) as unknown as BetterAuthType;
  return auth;
}

export type Auth = BetterAuthType;

export async function runInAuthTransaction<T>(
  tx: DrizzleTx,
  { auth, schema }: { auth: Auth; schema: Record<string, unknown> },
  fn: () => Promise<T>,
): Promise<T> {
  const adapter = drizzleAdapter(tx, { provider: 'pg', schema })(auth.options);
  return runWithTransaction(adapter, fn);
}
