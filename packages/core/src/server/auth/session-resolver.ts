import { createToken, type Token } from '@openora/core/contracts';
import type { DrizzleService } from '../db/index.js';
import { createAuth, type Auth } from './auth.js';

export const AUTH_SESSION: Token<SessionResolver> = createToken('AUTH_SESSION');

export class SessionResolver {
  readonly auth: Auth;

  constructor(drizzle: DrizzleService, schema?: Record<string, unknown>) {
    this.auth = createAuth({ db: drizzle.db, ...(schema ? { schema } : {}) });
  }

  async resolveUserId(headers: Headers): Promise<string | undefined> {
    return (await this.resolveSession(headers))?.userId;
  }

  async resolveSession(
    headers: Headers,
  ): Promise<{ userId: string; sessionId?: string | undefined } | undefined> {
    const resolved = await this.auth.api.getSession({ headers });
    const userId = resolved?.user?.id;
    return userId ? { userId, sessionId: resolved?.session?.id } : undefined;
  }
}
