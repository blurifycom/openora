import { implement, ORPCError } from '@orpc/server';
import {
  type OssContext,
  AdminGuard,
  mapErrors,
  getUserId,
  getSessionId,
  createEventStreamGenerator,
} from '@openora/core/server';
import { AuthGuardReasonSchema, type RealtimeTransport } from '@openora/core/contracts';
import { identityContract } from '../contract/index.js';
import type { User, Session } from '../schema/index.js';
import { PhoneLoginService } from '../service/phone-login.service.js';
import { PhoneVerificationService } from '../service/phone-verification.service.js';
import type { WithdrawalPinService } from '../service/withdrawal-pin.service.js';
import {
  AvatarHostNotAllowedError,
  IdentityService,
  UsernameConflictError,
  UserNotFoundError,
} from '../service/identity.service.js';
import {
  SessionService,
  SessionNotFoundError,
  CurrentSessionRevokeError,
} from '../service/session.service.js';
import { TrustedDeviceNotFoundError } from '../service/trusted-device.service.js';
import {
  type AdminSecurityService,
  SelfTwoFactorResetError,
  TwoFactorNotEnabledError,
} from '../service/admin-security.service.js';
import { UnsupportedLanguageError } from '../../shared/language.js';
import { UsernameBlockedError } from '../../shared/username.js';

const DURING_TWO_FACTOR_SETUP = { allowPendingTwoFactorSetup: true } as const;

const REACHABLE_DURING_TWO_FACTOR_SETUP: ReadonlySet<string> = new Set([
  'register',
  'usernameAvailable',
  'registrationPolicy',
  'login',
  'phoneLoginRequest',
  'phoneLoginVerify',
  'logout',
  'requestPasswordReset',
  'verifyPasswordResetOtp',
  'resetPassword',
  'me',
  'security.me',
  'streamSession',
  'enable2fa',
  'verify2fa',
  'sendTwoFactorOtp',
  'twoFactorStatus',
  'phoneVerification.request',
  'phoneVerification.confirm',
  'sessions.listMine',
  'sessions.revokeMine',
]);

function requireSessionId(context: OssContext) {
  const sessionId = getSessionId(context, DURING_TWO_FACTOR_SETUP);
  if (!sessionId) {
    throw new ORPCError('UNAUTHORIZED', { message: 'Not signed in.' });
  }
  return sessionId;
}

export function sessionEventsChannel(userId: User['id']): string {
  return `identity:session-events:${userId}`;
}

export type SessionEventsPush =
  | { type: 'revoked-all'; exceptSessionId?: Session['id'] }
  | { type: 'session-revoked'; sessionId: Session['id'] }
  | { type: 'unlocked' };

export function createIdentityRouter(
  identity: IdentityService,
  sessionSvc: SessionService,
  phoneLogin: PhoneLoginService,
  phoneVerification: PhoneVerificationService,
  adminGuard: AdminGuard,
  realtime: RealtimeTransport,
  adminSecurity: AdminSecurityService,
  withdrawalPin: WithdrawalPinService,
) {
  const assertMayActOnAccount = async (context: OssContext, userId: User['id']) => {
    const role = await identity.findAccountRole(userId);
    if (role !== null && role !== 'player') {
      await adminGuard.assertSuperAdmin(context);
    }
  };

  const os = implement(identityContract)
    .$context<OssContext>()
    .use(({ context, path, next }) => {
      const procedure = path.slice(1).join('.');
      if (
        context.auth?.twoFactorSetupRequired &&
        !REACHABLE_DURING_TWO_FACTOR_SETUP.has(procedure)
      ) {
        throw new ORPCError('FORBIDDEN', {
          message: 'Set up two-factor authentication to continue',
          data: { reason: AuthGuardReasonSchema.enum.two_factor_setup_required },
        });
      }
      return next();
    });

  return os.router({
    register: os.register.handler(({ input, context }) =>
      mapErrors({ CONFLICT: UsernameConflictError, BAD_REQUEST: UsernameBlockedError }, () =>
        identity.register(input, context.request.headers),
      ),
    ),

    usernameAvailable: os.usernameAvailable.handler(({ input, context }) =>
      identity.usernameAvailable(input.username, context.request.headers),
    ),

    registrationPolicy: os.registrationPolicy.handler(() => identity.registrationPolicy()),

    login: os.login.handler(({ input, context }) =>
      identity.login(input, context.request.headers, context.resHeaders ?? new Headers()),
    ),

    phoneLoginRequest: os.phoneLoginRequest.handler(({ input, context }) => {
      return phoneLogin.requestOtp({ ...input, ...context.clientMeta });
    }),

    phoneLoginVerify: os.phoneLoginVerify.handler(({ input, context }) => {
      return phoneLogin.verifyOtp(
        { ...input, ...context.clientMeta },
        context.resHeaders ?? new Headers(),
      );
    }),

    logout: os.logout.handler(({ context }) =>
      identity.logout(context.request.headers, context.resHeaders ?? new Headers()),
    ),

    me: os.me.handler(({ context }) => {
      if (context.resHeaders) {
        context.resHeaders.set('Cache-Control', 'no-store, no-cache, must-revalidate');
        context.resHeaders.set('Pragma', 'no-cache');
        context.resHeaders.set('Expires', '0');
      }
      return identity.me(context.request.headers);
    }),

    security: {
      me: os.security.me.handler(({ context }) =>
        identity.getSecurityControls(context.request.headers),
      ),

      loginWithdrawalAlerts: os.security.loginWithdrawalAlerts.handler(({ input, context }) =>
        identity.setLoginWithdrawalAlerts(input, context.request.headers),
      ),

      autoLogout: os.security.autoLogout.handler(({ input, context }) =>
        identity.setAutoLogoutDuration(input, context.request.headers),
      ),

      requireTwoFactorOnLogin: os.security.requireTwoFactorOnLogin.handler(({ input, context }) =>
        identity.setRequireTwoFactorOnLogin(input, context.request.headers),
      ),

      setWithdrawalPin: os.security.setWithdrawalPin.handler(({ input, context }) =>
        withdrawalPin.set(getUserId(context), input, context.request.headers, context.clientMeta),
      ),

      removeWithdrawalPin: os.security.removeWithdrawalPin.handler(({ input, context }) =>
        withdrawalPin.remove(
          getUserId(context),
          input,
          context.request.headers,
          context.clientMeta,
        ),
      ),

      setAntiPhishingCode: os.security.setAntiPhishingCode.handler(({ input, context }) =>
        identity.setAntiPhishingCode(input, context.request.headers),
      ),
    },

    phoneVerification: {
      request: os.phoneVerification.request.handler(({ input, context }) =>
        phoneVerification.request({
          userId: getUserId(context, DURING_TWO_FACTOR_SETUP),
          sessionId: requireSessionId(context),
          input,
          reqHeaders: context.request.headers,
          meta: context.clientMeta,
        }),
      ),

      confirm: os.phoneVerification.confirm.handler(({ input, context }) =>
        phoneVerification.confirm({
          userId: getUserId(context, DURING_TWO_FACTOR_SETUP),
          sessionId: requireSessionId(context),
          input,
          meta: context.clientMeta,
        }),
      ),
    },

    streamSession: os.streamSession.handler(({ signal, context }) => {
      const userId = getUserId(context, DURING_TWO_FACTOR_SETUP);
      const connectionSessionId = getSessionId(context, DURING_TWO_FACTOR_SETUP);
      return createEventStreamGenerator(
        (push) =>
          realtime.subscribe<SessionEventsPush>(sessionEventsChannel(userId), (event) => {
            if (event.type === 'unlocked') {
              push({ type: 'unlocked' });
              return;
            }
            if (event.type === 'session-revoked') {
              if (event.sessionId === connectionSessionId) {
                push({ type: 'revoked' });
              }
              return;
            }
            if (event.exceptSessionId && event.exceptSessionId === connectionSessionId) {
              return;
            }
            push({ type: 'revoked' });
          }),
        { signal },
      );
    }),

    enable2fa: os.enable2fa.handler(({ input, context }) =>
      identity.enableTwoFactor(input, context.request.headers, context.resHeaders ?? new Headers()),
    ),

    verify2fa: os.verify2fa.handler(({ input, context }) =>
      identity.verifyTwoFactor(input, context.request.headers, context.resHeaders ?? new Headers()),
    ),

    disable2fa: os.disable2fa.handler(({ input, context }) =>
      identity.disableTwoFactor(
        input,
        context.request.headers,
        context.resHeaders ?? new Headers(),
      ),
    ),

    sendTwoFactorOtp: os.sendTwoFactorOtp.handler(({ context }) =>
      identity.sendTwoFactorOtp(context.request.headers, context.resHeaders ?? new Headers()),
    ),

    twoFactorStatus: os.twoFactorStatus.handler(({ context }) =>
      identity.twoFactorStatus(context.request.headers),
    ),

    regenerateBackupCodes: os.regenerateBackupCodes.handler(({ input, context }) =>
      identity.regenerateBackupCodes(
        input,
        context.request.headers,
        context.resHeaders ?? new Headers(),
      ),
    ),

    requestPasswordReset: os.requestPasswordReset.handler(({ input }) =>
      identity.requestPasswordReset(input),
    ),

    verifyPasswordResetOtp: os.verifyPasswordResetOtp.handler(({ input }) =>
      identity.verifyPasswordResetOtp(input),
    ),

    resetPassword: os.resetPassword.handler(({ input }) => identity.resetPassword(input)),

    changePassword: os.changePassword.handler(({ input, context }) =>
      identity.changePassword(input, context.request.headers, context.resHeaders ?? new Headers(), {
        userId: getUserId(context),
        sessionId: requireSessionId(context),
      }),
    ),

    sendEmailVerification: os.sendEmailVerification.handler(({ input, context }) =>
      identity.sendEmailVerification(input, context.request.headers),
    ),

    verifyEmail: os.verifyEmail.handler(({ input, context }) =>
      identity.verifyEmail(input, context.request.headers, context.resHeaders ?? new Headers()),
    ),

    requestEmailChange: os.requestEmailChange.handler(({ input, context }) =>
      identity.requestEmailChange(
        input,
        context.request.headers,
        context.resHeaders ?? new Headers(),
      ),
    ),

    confirmEmailChange: os.confirmEmailChange.handler(({ input, context }) =>
      identity.confirmEmailChange(
        input,
        context.request.headers,
        context.resHeaders ?? new Headers(),
      ),
    ),

    updateProfile: os.updateProfile.handler(({ input, context }) =>
      mapErrors({ BAD_REQUEST: [UnsupportedLanguageError, AvatarHostNotAllowedError] }, () =>
        identity.updateProfile(input, context.request.headers, context.resHeaders ?? new Headers()),
      ),
    ),

    unlockUser: os.unlockUser.handler(async ({ input, context }) => {
      const caller = await adminGuard.assert(context, 'player', 'update');
      await assertMayActOnAccount(context, input.userId);
      return mapErrors({ NOT_FOUND: UserNotFoundError }, () =>
        identity.unlockUser(input.userId, caller.userId, {
          ip: caller.ip,
          userAgent: caller.userAgent,
        }),
      );
    }),

    adminRequestPasswordReset: os.adminRequestPasswordReset.handler(async ({ input, context }) => {
      const caller = await adminGuard.assert(context, 'player', 'update');
      await assertMayActOnAccount(context, input.userId);
      return mapErrors({ NOT_FOUND: UserNotFoundError }, () =>
        identity.adminRequestPasswordReset(input.userId, caller.userId, {
          ip: caller.ip,
          userAgent: caller.userAgent,
        }),
      );
    }),

    sessions: {
      list: os.sessions.list.handler(async ({ input, context }) => {
        await adminGuard.assert(context, 'sessions', 'view');
        return sessionSvc.listSessions({
          userId: input.userId,
          currentSessionId: getSessionId(context),
          page: input.page,
          limit: input.limit,
          sortBy: input.sortBy,
          sortOrder: input.sortOrder,
        });
      }),
      revoke: os.sessions.revoke.handler(async ({ input, context }) => {
        const caller = await adminGuard.assert(context, 'sessions', 'revoke');
        return mapErrors({ NOT_FOUND: SessionNotFoundError }, () =>
          sessionSvc.revokeSession(input.userId, input.id, caller.userId, {
            ip: caller.ip,
            userAgent: caller.userAgent,
          }),
        );
      }),
      revokeAll: os.sessions.revokeAll.handler(async ({ input, context }) => {
        const caller = await adminGuard.assert(context, 'sessions', 'revoke');
        return sessionSvc.revokeAllSessions(input.userId, caller.userId, {
          ip: caller.ip,
          userAgent: caller.userAgent,
        });
      }),

      listMine: os.sessions.listMine.handler(({ input, context }) =>
        sessionSvc.listSessions({
          userId: getUserId(context, DURING_TWO_FACTOR_SETUP),
          currentSessionId: getSessionId(context, DURING_TWO_FACTOR_SETUP),
          activeOnly: true,
          page: input.page,
          limit: input.limit,
          sortBy: input.sortBy,
          sortOrder: input.sortOrder,
        }),
      ),

      revokeMine: os.sessions.revokeMine.handler(({ input, context }) => {
        const userId = getUserId(context, DURING_TWO_FACTOR_SETUP);
        return mapErrors(
          { NOT_FOUND: SessionNotFoundError, CONFLICT: CurrentSessionRevokeError },
          () =>
            sessionSvc.revokeOwnSession(
              userId,
              input.id,
              getSessionId(context, DURING_TWO_FACTOR_SETUP),
              context.clientMeta,
            ),
        );
      }),

      listAll: os.sessions.listAll.handler(async ({ input, context }) => {
        await adminGuard.assert(context, 'sessions', 'view');
        await adminGuard.assert(context, 'player', 'view');
        return sessionSvc.listAllActiveSessions({
          role: input.role,
          query: input.query,
          currentSessionId: getSessionId(context),
          page: input.page,
          limit: input.limit,
          sortBy: input.sortBy,
          sortOrder: input.sortOrder,
        });
      }),
    },

    adminSecurity: {
      status: os.adminSecurity.status.handler(({ context }) =>
        adminSecurity.status(getUserId(context), context.clientMeta.userAgent),
      ),

      trustedDevices: os.adminSecurity.trustedDevices.handler(({ context }) =>
        adminSecurity.listTrustedDevices(getUserId(context), context.clientMeta.userAgent),
      ),

      trustCurrentDevice: os.adminSecurity.trustCurrentDevice.handler(({ input, context }) =>
        identity.trustCurrentDevice(
          input,
          context.request.headers,
          context.resHeaders ?? new Headers(),
        ),
      ),

      revokeTrustedDevice: os.adminSecurity.revokeTrustedDevice.handler(({ input, context }) => {
        const userId = getUserId(context);
        return mapErrors({ NOT_FOUND: TrustedDeviceNotFoundError }, () =>
          adminSecurity.revokeTrustedDevice(
            userId,
            input.id,
            userId,
            context.clientMeta,
            getSessionId(context),
          ),
        );
      }),

      resetUserTwoFactor: os.adminSecurity.resetUserTwoFactor.handler(
        async ({ input, context }) => {
          const caller = await adminGuard.assertSuperAdmin(context, {
            resource: 'player',
            action: 'resetTwoFactor',
          });
          return mapErrors(
            { NOT_FOUND: UserNotFoundError, CONFLICT: SelfTwoFactorResetError },
            () =>
              adminSecurity.resetTwoFactor(input.userId, caller.userId, input.reason, {
                ip: caller.ip,
                userAgent: caller.userAgent,
              }),
          );
        },
      ),

      resetPlayerTwoFactor: os.adminSecurity.resetPlayerTwoFactor.handler(
        async ({ input, context }) => {
          const caller = await adminGuard.assert(context, 'player', 'update');
          return mapErrors(
            { NOT_FOUND: UserNotFoundError, CONFLICT: TwoFactorNotEnabledError },
            () =>
              adminSecurity.resetPlayerTwoFactor(input.userId, caller.userId, input.reason, {
                ip: caller.ip,
                userAgent: caller.userAgent,
              }),
          );
        },
      ),

      revokeUserTrustedDevice: os.adminSecurity.revokeUserTrustedDevice.handler(
        async ({ input, context }) => {
          const caller = await adminGuard.assertSuperAdmin(context, {
            resource: 'player',
            action: 'revokeTrustedDevice',
          });
          return mapErrors({ NOT_FOUND: TrustedDeviceNotFoundError }, () =>
            adminSecurity.revokeTrustedDevice(input.userId, input.id, caller.userId, {
              ip: caller.ip,
              userAgent: caller.userAgent,
            }),
          );
        },
      ),
    },
  });
}
