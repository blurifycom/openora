import { implement } from '@orpc/server';
import { type OssContext, AdminGuard } from '@blurifycom/core/server';
import { identityContract } from '../contract/index.js';
import { IdentityService } from '../service/identity.service.js';
import { SessionService } from '../service/session.service.js';

export function createIdentityRouter(
  identity: IdentityService,
  sessionSvc: SessionService,
  adminGuard: AdminGuard,
) {
  const os = implement(identityContract).$context<OssContext>();

  return os.router({
    register: os.register.handler(({ input, context }) =>
      identity.register(input, context.request.headers, context.resHeaders ?? new Headers()),
    ),

    login: os.login.handler(({ input, context }) =>
      identity.login(input, context.request.headers, context.resHeaders ?? new Headers()),
    ),

    logout: os.logout.handler(({ context }) =>
      identity.logout(context.request.headers, context.resHeaders ?? new Headers()),
    ),

    me: os.me.handler(({ context }) => identity.me(context.request.headers)),

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
      identity.updateProfile(input, context.request.headers, context.resHeaders ?? new Headers()),
    ),

    unlockUser: os.unlockUser.handler(async ({ input, context }) => {
      const caller = await adminGuard.assert(context, 'player', 'update');
      return identity.unlockUser(input.userId, caller.userId);
    }),

    sessions: {
      list: os.sessions.list.handler(({ context }) =>
        sessionSvc.listSessions(context.request.headers),
      ),
      revoke: os.sessions.revoke.handler(({ input, context }) =>
        sessionSvc.revokeSession(input.token, context.request.headers),
      ),
      revokeAll: os.sessions.revokeAll.handler(({ context }) =>
        sessionSvc.revokeAllSessions(context.request.headers),
      ),
    },
  });
}
