import { createToken, type Token } from '@oss/adapters';
import type { DrizzleService } from '@oss/db';
import { createAuth, type Auth } from './auth.js';

// The single source of truth for "who is the caller?". It verifies the
// better-auth session cookie on the incoming request headers and returns the
// authenticated user id - never trusting a client-supplied identity header.
//
// One shared better-auth instance backs both the per-request identity resolution
// (createApp middleware) and the AdminGuard, so we never run two createAuth()
// inits over the same DB. @oss/core cannot import this (it would create an
// auth->core->auth cycle and pull better-auth into the leaf platform package), so
// the resolver is bound in createApp via the AUTH_SESSION token and the verified
// userId is published onto the oRPC context for getUserId to read.
export const AUTH_SESSION: Token<SessionResolver> = createToken('AUTH_SESSION');

export class SessionResolver {
  readonly auth: Auth;

  // `schema` carries the better-auth tables (user/session/account/verification).
  // It MUST be provided - the drizzle adapter resolves models from it, and
  // getSession() throws "model session not found" without it. @oss/auth can't
  // import the schema (it lives in the @oss-addons/identity add-on), so createApp injects it.
  constructor(drizzle: DrizzleService, schema?: Record<string, unknown>) {
    this.auth = createAuth({ db: drizzle.db, ...(schema ? { schema } : {}) });
  }

  // Verify the session cookie carried on `headers` and return the authenticated
  // user id, or undefined when there is no valid session. Never throws on a
  // missing/invalid session - public routes (login, register, health) legitimately
  // have no session, and the caller decides whether absence is an error.
  async resolveUserId(headers: Headers): Promise<string | undefined> {
    const session = await this.auth.api.getSession({ headers });
    return session?.user?.id;
  }
}
