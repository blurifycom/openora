import { ORPCError } from '@orpc/server';
import {
  internalProcedure,
  SESSION_RESOLVER_ROUTE,
  SessionResolverWire,
  type RequestSessionResolver,
} from '@openora/core/server';
import { accountReaderCallers } from './internal-accounts.router.js';

/**
 * The services allowed to resolve sessions: `SESSION_RESOLVER_CALLERS`, a comma list of names.
 * Its own list, not `ACCOUNT_READER_CALLERS`: reading accounts and turning a credential into an
 * identity are different grants, and the second also moves the session's idle clock.
 */
export const sessionResolverCallers = accountReaderCallers;

/**
 * The internal API behind `REMOTE_SESSION_RESOLVER`, for a service with no session tables of
 * its own. It runs the same chain a local request runs (session, idle window, second-factor
 * enrolment, last-seen stamp) on the credentials the caller forwards, so a request served by
 * another service keeps a player's session and presence alive exactly as one served here does.
 * `resolver` must be the local chain, never a remote one. Only the services named in `callers`
 * may ask. This guards against misconfiguration only: one install-wide secret signs as any
 * caller name.
 */
export function createInternalSessionRouter(
  resolver: RequestSessionResolver,
  callers: ReadonlySet<string>,
) {
  return {
    session: internalProcedure
      .use(({ context, next }) => {
        if (!callers.has(context.internalCaller)) {
          throw new ORPCError('FORBIDDEN', { message: 'This service may not resolve sessions' });
        }
        return next();
      })
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
