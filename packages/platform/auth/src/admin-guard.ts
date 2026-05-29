import { ORPCError } from '@orpc/server';
import { createToken, type Token } from '@oss/adapters';
import { DrizzleService } from '@oss/db';
import { sql } from 'drizzle-orm';
import { createAuth, type Auth } from './auth.js';
import { roles, type ResourceName, type ActionOf } from './permissions.js';

type RequestLike = { headers: Record<string, string | string[] | undefined> };

export const ADMIN_GUARD: Token<AdminGuard> = createToken('ADMIN_GUARD');

export class AdminGuard {
  private readonly auth: Auth;

  // `schema` carries the better-auth tables (user/session/account/verification).
  // It MUST be provided - the drizzle adapter resolves models from it, and
  // getSession() throws "model session not found" without it. @oss/auth can't
  // import the schema (it lives in @oss/modules), so createApp injects it.
  constructor(
    private readonly drizzle: DrizzleService,
    schema?: Record<string, unknown>,
  ) {
    this.auth = createAuth({ db: drizzle.db, ...(schema ? { schema } : {}) });
  }

  async assert(context: unknown): Promise<{ userId: string }>;
  async assert<R extends ResourceName>(
    context: unknown,
    resource: R,
    action: ActionOf<R>,
  ): Promise<{ userId: string }>;
  async assert<R extends ResourceName>(
    context: unknown,
    resource?: R,
    action?: ActionOf<R>,
  ): Promise<{ userId: string }> {
    const request = (context as { request?: RequestLike }).request;
    if (!request || typeof request.headers !== 'object') {
      throw new ORPCError('UNAUTHORIZED', { message: 'Missing request context' });
    }

    const headers = new Headers();
    for (const [k, v] of Object.entries(request.headers)) {
      if (v === undefined) continue;
      headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    }

    const session = await this.auth.api.getSession({ headers });
    const userId = session?.user?.id;
    if (!userId) {
      throw new ORPCError('UNAUTHORIZED', { message: 'Authentication required' });
    }

    const result = await this.drizzle.db.execute(
      sql`SELECT id, role FROM "user" WHERE id = ${userId} LIMIT 1`,
    );
    const userRecord = result.rows[0] as { id: string; role: string } | undefined;
    if (!userRecord) {
      throw new ORPCError('FORBIDDEN', { message: 'Admin access required' });
    }

    if (resource !== undefined && action !== undefined) {
      const userRole = roles[userRecord.role as keyof typeof roles];
      if (!userRole) {
        throw new ORPCError('FORBIDDEN', { message: 'Admin access required' });
      }
      const check = userRole.authorize({ [resource]: [action] });
      if (!check.success) {
        throw new ORPCError('FORBIDDEN', {
          message: `Missing permission: ${String(resource)}:${String(action)}`,
        });
      }
    } else if (userRecord.role === 'player') {
      throw new ORPCError('FORBIDDEN', { message: 'Admin access required' });
    }

    return { userId };
  }
}
