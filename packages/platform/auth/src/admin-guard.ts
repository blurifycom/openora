import { Injectable } from '@nestjs/common';
import { ORPCError } from '@orpc/server';
import { DrizzleService } from '@oss/db';
import { sql } from 'drizzle-orm';
import { createAuth, type Auth } from './auth.js';

type RequestLike = { headers: Record<string, string | string[] | undefined> };

@Injectable()
export class AdminGuard {
  private readonly auth: Auth;

  constructor(private readonly drizzle: DrizzleService) {
    this.auth = createAuth({ db: drizzle.db });
  }

  async assert(context: unknown): Promise<{ userId: string }> {
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
    if (!userRecord || userRecord.role !== 'admin') {
      throw new ORPCError('FORBIDDEN', { message: 'Admin access required' });
    }

    return { userId };
  }
}
