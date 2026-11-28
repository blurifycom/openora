import { ORPCError } from '@orpc/server';
import {
  ADMIN_SECURITY_ROUTE,
  AdminSecurityWire,
  AuthGuardReasonSchema,
  type AdminSecurityPolicy,
} from '@openora/core/contracts';
import {
  internalProcedureFor,
  SESSION_RESOLVER_ROUTE,
  SessionResolverWire,
  type RequestSessionResolver,
} from '@openora/core/server';

const reasonOf = (err: ORPCError<string, unknown>) => {
  const reason = AuthGuardReasonSchema.safeParse((err.data as { reason?: unknown } | null)?.reason);
  return reason.success ? reason.data : undefined;
};

export function createInternalSessionRouter(
  resolver: RequestSessionResolver,
  adminSecurity: AdminSecurityPolicy,
  callers: ReadonlySet<string>,
) {
  const callerProcedure = internalProcedureFor(callers, 'This service may not resolve sessions');
  return {
    adminSecurity: callerProcedure
      .route({ method: 'POST', path: ADMIN_SECURITY_ROUTE })
      .input(AdminSecurityWire.input)
      .output(AdminSecurityWire.output)
      .handler(async ({ input: { check, ...caller } }) => {
        try {
          await (check === 'enrolled'
            ? adminSecurity.assertEnrolled(caller)
            : adminSecurity.assertSessionIntact(caller));
          return { refusal: null };
        } catch (err) {
          if (
            err instanceof ORPCError &&
            (err.code === 'FORBIDDEN' || err.code === 'UNAUTHORIZED')
          ) {
            const reason = reasonOf(err);
            return {
              refusal: { code: err.code, message: err.message, ...(reason ? { reason } : {}) },
            };
          }
          throw err;
        }
      }),
    session: callerProcedure
      .route({ method: 'POST', path: SESSION_RESOLVER_ROUTE })
      .input(SessionResolverWire.input)
      .output(SessionResolverWire.output)
      .handler(async ({ input }) => {
        const headers = new Headers();
        if (input.cookie) {
          headers.set('cookie', input.cookie);
        }
        if (input.authorization) {
          headers.set('authorization', input.authorization);
        }
        const { auth, sessionEndedReason } = await resolver.resolve(headers);
        return { auth: auth ?? null, ...(sessionEndedReason ? { sessionEndedReason } : {}) };
      }),
  };
}
