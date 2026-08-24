import { createToken, type Token } from '@openora/core/contracts';
import type { DrizzleService } from '../db/index.js';
import { createAuth, type Auth } from './auth.js';

// One shared better-auth instance backs both the per-request identity resolution
// (createApp middleware) and the AdminGuard, so we never run two createAuth()
// inits over the same DB. @openora/core/server cannot import this (it would create an
// auth->core->auth cycle and pull better-auth into the leaf platform package), so
// the resolver is bound in createApp via the AUTH_SESSION token and the verified
// userId is published onto the oRPC context for getUserId to read.
export const AUTH_SESSION: Token<SessionResolver> = createToken('AUTH_SESSION');

export class SessionResolver {
  readonly auth: Auth;

  // schema MUST be provided - drizzle adapter resolves models from it and getSession()
  // throws "model session not found" without it. @openora/core/server can't import the
  // schema (it lives in @openora/pam), so createApp injects it.
  constructor(drizzle: DrizzleService, schema?: Record<string, unknown>) {
    this.auth = createAuth({ db: drizzle.db, ...(schema ? { schema } : {}) });
  }

  async resolveUserId(headers: Headers): Promise<string | undefined> {
    return (await this.resolveSession(headers))?.userId;
  }

  // sessionId identifies the session row itself, so a handler can tell the caller's
  // own device apart from their others. Optional because a stubbed/partial getSession
  // response still carries a usable userId.
  async resolveSession(
    headers: Headers,
  ): Promise<{ userId: string; sessionId?: string | undefined } | undefined> {
    const resolved = await this.auth.api.getSession({ headers });
    const userId = resolved?.user?.id;
    return userId ? { userId, sessionId: resolved?.session?.id } : undefined;
  }
}
