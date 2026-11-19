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

// The reason an `AdminSecurityService` refusal carries, when it is one the contract names.
const reasonOf = (err: ORPCError<string, unknown>) => {
  const reason = AuthGuardReasonSchema.safeParse((err.data as { reason?: unknown } | null)?.reason);
  return reason.success ? reason.data : undefined;
};

/**
 * The internal API behind `REMOTE_SESSION_RESOLVER`, for a service with no session tables of
 * its own. It runs the same chain a local request runs (session, idle window, second-factor
 * enrolment, last-seen stamp) on the credentials the caller forwards, so a request served by
 * another service keeps a player's session and presence alive exactly as one served here does.
 * `resolver` must be the local chain, never a remote one. The admin session checks (mandatory
 * second factor, device binding) run here too, as the same `adminSecurity` the identity service
 * enforces on its own admin routes, so a service without those rows cannot skip them. Only the
 * services named in `callers` (`SESSION_RESOLVER_CALLERS`, a comma list: its own grant, apart from
 * `ACCOUNT_READER_CALLERS`, because it also moves the session's idle clock) may ask. This guards against misconfiguration only: one install-wide secret signs as any
 * caller name.
 */
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
          // Only the policy's own refusals are an answer; anything else is a failure the
          // caller must treat as one, never as a pass.
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
