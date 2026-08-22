import { eq } from 'drizzle-orm';
import { DatabaseError } from 'pg';
import { ORPCError } from '@orpc/server';
import type { DrizzleService } from '@openora/core/server';
import type { User, UserCommands } from '@openora/core/contracts';
import { user } from '../schema/index.js';

function isUsernameCollision(error: unknown): boolean {
  const cause = error instanceof DatabaseError ? error : (error as Error)?.cause;
  return (
    cause instanceof DatabaseError &&
    cause.code === '23505' &&
    cause.constraint === 'user_username_unique'
  );
}

/** Identity owns the `user` table, so sibling modules mutate it through this port. */
export class DrizzleUserCommands implements UserCommands {
  constructor(private readonly drizzle: DrizzleService) {}

  async setUsername(userId: User['id'], username: string) {
    try {
      await this.drizzle.db.update(user).set({ username }).where(eq(user.id, userId));
    } catch (error) {
      if (isUsernameCollision(error)) {
        // Thrown as the transport error rather than a domain class: consumers live in
        // sibling modules and cannot import identity's internals to map it.
        throw new ORPCError('CONFLICT', { message: 'Username is already in use' });
      }
      throw error;
    }
    return { success: true };
  }
}
