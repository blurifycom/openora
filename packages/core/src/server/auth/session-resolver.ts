import { createToken, type Token } from '../../contracts/adapters/index.js';
import type { DrizzleService } from '../db/index.js';
import { createAuth, type Auth } from './auth.js';

// One shared better-auth instance backs both the per-request identity resolution
// (createApp middleware) and the AdminGuard, so we never run two createAuth()
// inits over the same DB. @blurifycom/core/server cannot import this (it would create an
// auth->core->auth cycle and pull better-auth into the leaf platform package), so
// the resolver is bound in createApp via the AUTH_SESSION token and the verified
// userId is published onto the oRPC context for getUserId to read.
export const AUTH_SESSION: Token<SessionResolver> = createToken('AUTH_SESSION');

export class SessionResolver {
  readonly auth: Auth;

  // schema MUST be provided - drizzle adapter resolves models from it and getSession()
  // throws "model session not found" without it. @blurifycom/core/server can't import the
  // schema (it lives in @blurifycom/pam), so createApp injects it.
  constructor(drizzle: DrizzleService, schema?: Record<string, unknown>) {
    this.auth = createAuth({ db: drizzle.db, ...(schema ? { schema } : {}) });
  }

  // Returns undefined (not throws) on a missing/invalid session - public routes legitimately have none.
  async resolveUserId(headers: Headers): Promise<string | undefined> {
    const session = await this.auth.api.getSession({ headers });
    return session?.user?.id;
  }
}
