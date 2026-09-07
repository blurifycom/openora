import { implement, ORPCError } from '@orpc/server';
import {
  type OssContext,
  AdminGuard,
  mapErrors,
  getUserId,
  getSessionId,
  createEventStreamGenerator,
  type EventBus,
} from '@openora/core/server';
import { identityContract } from '../contract/index.js';
import { PhoneLoginService } from '../service/phone-login.service.js';
import { PhoneVerificationService } from '../service/phone-verification.service.js';
import {
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
} from '../service/admin-security.service.js';
import { UnsupportedLanguageError } from '../../shared/language.js';

function requireSessionId(context: OssContext) {
  const sessionId = getSessionId(context);
  if (!sessionId) {
    throw new ORPCError('UNAUTHORIZED', { message: 'Not signed in.' });
  }
  return sessionId;
}

export function createIdentityRouter(
  identity: IdentityService,
  sessionSvc: SessionService,
  phoneLogin: PhoneLoginService,
  phoneVerification: PhoneVerificationService,
  adminGuard: AdminGuard,
  eventBus: EventBus,
  adminSecurity: AdminSecurityService,
) {
  const os = implement(identityContract).$context<OssContext>();

  return os.router({
    register: os.register.handler(({ input, context }) =>
      mapErrors({ CONFLICT: UsernameConflictError }, () =>
        identity.register(input, context.request.headers),
      ),
    ),

    usernameAvailable: os.usernameAvailable.handler(({ input, context }) =>
      identity.usernameAvailable(input.username, context.request.headers),
    ),

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
      // Disable browser caching for the session state query. This prevents aggressive
      // heuristic caching (e.g. in Chrome/Safari) from serving a stale logged-in session
      // state after the session is revoked or logged out.
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
    },

    phoneVerification: {
      request: os.phoneVerification.request.handler(({ input, context }) =>
        phoneVerification.request({
          userId: getUserId(context),
          sessionId: requireSessionId(context),
          input,
          reqHeaders: context.request.headers,
          meta: context.clientMeta,
        }),
      ),

      confirm: os.phoneVerification.confirm.handler(({ input, context }) =>
        phoneVerification.confirm({
          userId: getUserId(context),
          sessionId: requireSessionId(context),
          input,
          meta: context.clientMeta,
        }),
      ),
    },

    streamSession: os.streamSession.handler(({ signal, context }) => {
      const userId = getUserId(context);
      return createEventStreamGenerator(
        (push) => {
          const unsubscribeRevoked = eventBus.on('identity.sessions.revoked_all', (event) => {
            if (event.userId === userId) {
              push({ type: 'revoked' });
            }
          });
          const unsubscribeUnlocked = eventBus.on('identity.user.unlocked', (event) => {
            if (event.userId === userId) {
              push({ type: 'unlocked' });
            }
          });
          return () => {
            unsubscribeRevoked();
            unsubscribeUnlocked();
          };
        },
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
      identity.changePassword(input, context.request.headers, context.resHeaders ?? new Headers()),
    ),

    sendEmailVerification: os.sendEmailVerification.handler(({ input, context }) =>
      identity.sendEmailVerification(input, context.request.headers),
    ),

    verifyEmail: os.verifyEmail.handler(({ input, context }) =>
      identity.verifyEmail(input, context.request.headers, context.resHeaders ?? new Headers()),
    ),

    changeEmail: os.changeEmail.handler(({ input, context }) =>
      identity.changeEmail(input, context.request.headers, context.resHeaders ?? new Headers()),
    ),

    updateProfile: os.updateProfile.handler(({ input, context }) =>
      mapErrors({ BAD_REQUEST: UnsupportedLanguageError }, () =>
        identity.updateProfile(input, context.request.headers, context.resHeaders ?? new Headers()),
      ),
    ),

    unlockUser: os.unlockUser.handler(async ({ input, context }) => {
      const caller = await adminGuard.assert(context, 'player', 'update');
      return mapErrors({ NOT_FOUND: UserNotFoundError }, () =>
        identity.unlockUser(input.userId, caller.userId, {
          ip: caller.ip,
          userAgent: caller.userAgent,
        }),
      );
    }),

    adminRequestPasswordReset: os.adminRequestPasswordReset.handler(async ({ input, context }) => {
      const caller = await adminGuard.assert(context, 'player', 'update');
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
          userId: getUserId(context),
          currentSessionId: getSessionId(context),
          activeOnly: true,
          page: input.page,
          limit: input.limit,
          sortBy: input.sortBy,
          sortOrder: input.sortOrder,
        }),
      ),

      // Scoped to the caller's own userId, so a forged id cannot kill someone
      // else's device - a miss is a 404, not a cross-user revoke.
      revokeMine: os.sessions.revokeMine.handler(({ input, context }) => {
        const userId = getUserId(context);
        return mapErrors(
          { NOT_FOUND: SessionNotFoundError, CONFLICT: CurrentSessionRevokeError },
          () =>
            sessionSvc.revokeOwnSession(
              userId,
              input.id,
              getSessionId(context),
              context.clientMeta,
            ),
        );
      }),

      listAll: os.sessions.listAll.handler(async ({ input, context }) => {
        await adminGuard.assert(context, 'sessions', 'view');
        // The cross-user list returns player email/role/IP with free-text email
        // search, so it needs the player-data permission on top of session hygiene.
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
          const caller = await adminGuard.assertSuperAdmin(context);
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

      revokeUserTrustedDevice: os.adminSecurity.revokeUserTrustedDevice.handler(
        async ({ input, context }) => {
          const caller = await adminGuard.assertSuperAdmin(context);
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
