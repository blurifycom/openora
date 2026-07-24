import { implement } from '@orpc/server';
import {
  type OssContext,
  type NodeHeaders,
  AdminGuard,
  mapErrors,
  getUserId,
  createEventStreamGenerator,
  type EventBus,
} from '@openora/core/server';
import { identityContract } from '../contract/index.js';
import { PhoneLoginService } from '../service/phone-login.service.js';
import { IdentityService, UserNotFoundError } from '../service/identity.service.js';
import { SessionService, SessionNotFoundError } from '../service/session.service.js';
import { UnsupportedLanguageError } from '../../shared/language.js';

function nodeForwardedFor(headers: NodeHeaders): string | null {
  const fwd = headers['x-forwarded-for'];
  const first = Array.isArray(fwd) ? fwd[0] : fwd;
  const real = headers['x-real-ip'];
  return first?.split(',')[0]?.trim() || (Array.isArray(real) ? real[0] : real) || null;
}

function nodeUserAgent(headers: NodeHeaders): string | null {
  const ua = headers['user-agent'];
  return (Array.isArray(ua) ? ua[0] : ua) ?? null;
}

export function createIdentityRouter(
  identity: IdentityService,
  sessionSvc: SessionService,
  phoneLogin: PhoneLoginService,
  adminGuard: AdminGuard,
  eventBus: EventBus,
) {
  const os = implement(identityContract).$context<OssContext>();

  return os.router({
    register: os.register.handler(({ input, context }) =>
      identity.register(input, context.request.headers, context.resHeaders ?? new Headers()),
    ),

    login: os.login.handler(({ input, context }) =>
      identity.login(input, context.request.headers, context.resHeaders ?? new Headers()),
    ),

    phoneLoginRequest: os.phoneLoginRequest.handler(({ input, context }) => {
      const h = context.request.headers;
      return phoneLogin.requestOtp({
        ...input,
        ip: nodeForwardedFor(h),
        userAgent: nodeUserAgent(h),
      });
    }),

    phoneLoginVerify: os.phoneLoginVerify.handler(({ input, context }) => {
      const h = context.request.headers;
      return phoneLogin.verifyOtp(
        {
          ...input,
          ip: nodeForwardedFor(h),
          userAgent: nodeUserAgent(h),
        },
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

    sendEmailVerification: os.sendEmailVerification.handler(({ context }) =>
      identity.sendEmailVerification(context.request.headers),
    ),

    verifyEmail: os.verifyEmail.handler(({ input, context }) =>
      identity.verifyEmail(input, context.request.headers),
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
        identity.unlockUser(input.userId, caller.userId),
      );
    }),

    sessions: {
      list: os.sessions.list.handler(async ({ input, context }) => {
        await adminGuard.assert(context, 'sessions', 'view');
        return sessionSvc.listSessions({
          userId: input.userId,
          page: input.page,
          limit: input.limit,
          sortBy: input.sortBy,
          sortOrder: input.sortOrder,
        });
      }),
      revoke: os.sessions.revoke.handler(async ({ input, context }) => {
        const caller = await adminGuard.assert(context, 'sessions', 'revoke');
        return mapErrors({ NOT_FOUND: SessionNotFoundError }, () =>
          sessionSvc.revokeSession(input.userId, input.id, caller.userId),
        );
      }),
      revokeAll: os.sessions.revokeAll.handler(async ({ input, context }) => {
        const caller = await adminGuard.assert(context, 'sessions', 'revoke');
        return sessionSvc.revokeAllSessions(input.userId, caller.userId);
      }),
    },
  });
}
