import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DatabaseError } from 'pg';
import { ORPCError } from '@orpc/server';
import { hashPassword } from 'better-auth/crypto';
import { findOneOrThrow } from '@openora/core/server';
import type { DrizzleService, DrizzleTx } from '@openora/core/server';
import type { User, UserCommands } from '@openora/core/contracts';
import { account, user } from '../schema/index.js';

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const cause = error instanceof DatabaseError ? error : (error as Error)?.cause;
  return (
    cause instanceof DatabaseError && cause.code === '23505' && cause.constraint === constraint
  );
}

const generatedAdminUsername = () => `admin_${randomBytes(6).toString('hex')}`;

/** Identity owns the `user` table, so sibling modules mutate it through this port. */
export class DrizzleUserCommands implements UserCommands {
  constructor(private readonly drizzle: DrizzleService) {}

  async setUsername(userId: User['id'], username: string, tx?: unknown) {
    const db = tx === undefined ? this.drizzle.db : (tx as DrizzleTx);
    try {
      // Registration writes the handle to `name` too; keep them in step so the old handle cannot linger.
      await db.update(user).set({ username, name: username }).where(eq(user.id, userId));
    } catch (error) {
      if (isUniqueViolation(error, 'user_username_unique')) {
        // Thrown as the transport error rather than a domain class: consumers live in
        // sibling modules and cannot import identity's internals to map it.
        throw new ORPCError('CONFLICT', { message: 'Username is already in use' });
      }
      throw error;
    }
    return { success: true };
  }

  async createAdmin(input: { email: string; name: string; password: string }, tx?: unknown) {
    const db = tx === undefined ? this.drizzle.db : (tx as DrizzleTx);
    const passwordHash = await hashPassword(input.password);
    try {
      const created = findOneOrThrow(
        await db
          .insert(user)
          .values({
            // better-auth stores emails lowercased; sign-up and sign-in must agree with this row.
            email: input.email.toLowerCase(),
            name: input.name,
            username: generatedAdminUsername(),
            role: 'admin',
            emailVerified: true,
            passwordMeetsPolicy: true,
          })
          .returning({ id: user.id }),
        new Error('admin user insert returned no row'),
      );
      await db.insert(account).values({
        userId: created.id,
        accountId: created.id,
        providerId: 'credential',
        password: passwordHash,
      });
      return created;
    } catch (error) {
      if (isUniqueViolation(error, 'user_email_unique')) {
        throw new ORPCError('CONFLICT', {
          message: 'Email is already in use',
          data: { reason: 'email_taken' },
        });
      }
      throw error;
    }
  }
}
