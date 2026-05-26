import { Injectable, Inject } from '@nestjs/common';
import { createAuth } from '@oss/auth';
import { type EventBus, EVENT_BUS } from '@oss/core';
import { DrizzleService } from '@oss/db';
import { user, session, account, verification } from '../schema/index.js';
import type { User } from '@oss/shared-schemas';
import type { LoginInput, RegisterInput } from '@oss/shared-schemas';
import type { Response } from 'express';

function nodeHeadersToHeaders(nodeHeaders: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeHeaders)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

// better-auth returns Dates for createdAt/updatedAt and may omit image. The
// public UserSchema requires ISO strings, so coerce here before handing the
// object back to oRPC for output validation.
type BetterAuthUser = {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  image?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

function toUser(u: BetterAuthUser): User {
  const createdAt = u.createdAt instanceof Date ? u.createdAt.toISOString() : u.createdAt;
  const updatedAt = u.updatedAt instanceof Date ? u.updatedAt.toISOString() : u.updatedAt;
  const base = {
    id: u.id,
    email: u.email,
    name: u.name,
    emailVerified: u.emailVerified,
    createdAt,
    updatedAt,
  };
  return u.image !== undefined ? { ...base, image: u.image } : base;
}

// Forward every Set-Cookie header better-auth produced into the Express response,
// so the browser stores the session cookie and subsequent requests authenticate.
function forwardCookies(authResponse: globalThis.Response, expressRes: Response): void {
  const cookies: string[] = [];
  authResponse.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') cookies.push(value);
  });
  if (cookies.length > 0) {
    const existing = expressRes.getHeader('set-cookie');
    const merged: string[] = Array.isArray(existing)
      ? [...existing, ...cookies]
      : existing
        ? [String(existing), ...cookies]
        : cookies;
    expressRes.setHeader('set-cookie', merged);
  }
}

@Injectable()
export class IdentityService {
  private readonly auth: ReturnType<typeof createAuth>;

  constructor(
    private readonly drizzle: DrizzleService,
    @Inject(EVENT_BUS) private readonly events: EventBus,
  ) {
    this.auth = createAuth({ db: this.drizzle.db, schema: { user, session, account, verification } });
  }

  async register(
    input: RegisterInput,
    reqHeaders: Record<string, string | string[] | undefined>,
    res: Response,
  ) {
    const headers = nodeHeadersToHeaders(reqHeaders);
    const authResponse = await this.auth.api.signUpEmail({
      body: { email: input.email, password: input.password, name: input.name },
      headers,
      asResponse: true,
    });
    forwardCookies(authResponse, res);
    const body = (await authResponse.json()) as { user: BetterAuthUser };
    this.events.emit('identity.user.registered', { userId: body.user.id });
    return { user: toUser(body.user) };
  }

  async login(
    input: LoginInput,
    reqHeaders: Record<string, string | string[] | undefined>,
    res: Response,
  ) {
    const headers = nodeHeadersToHeaders(reqHeaders);
    const authResponse = await this.auth.api.signInEmail({
      body: { email: input.email, password: input.password },
      headers,
      asResponse: true,
    });
    forwardCookies(authResponse, res);
    const body = (await authResponse.json()) as {
      user: BetterAuthUser;
      token: string;
      session?: { expiresAt: string | Date };
    };
    this.events.emit('identity.user.login', { userId: body.user.id });
    const expiresAtRaw = body.session?.expiresAt;
    const expiresAt = expiresAtRaw
      ? expiresAtRaw instanceof Date
        ? expiresAtRaw.toISOString()
        : new Date(expiresAtRaw).toISOString()
      : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    return {
      user: toUser(body.user),
      session: { token: body.token, expiresAt },
    };
  }

  async logout(reqHeaders: Record<string, string | string[] | undefined>, res: Response) {
    const headers = nodeHeadersToHeaders(reqHeaders);
    const authResponse = await this.auth.api.signOut({ headers, asResponse: true });
    forwardCookies(authResponse, res);
    return { success: true as const };
  }

  async me(reqHeaders: Record<string, string | string[] | undefined>): Promise<User | null> {
    const headers = nodeHeadersToHeaders(reqHeaders);
    const session = await this.auth.api.getSession({ headers });
    if (!session?.user) return null;
    return toUser(session.user as BetterAuthUser);
  }
}
