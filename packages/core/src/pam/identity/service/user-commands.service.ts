import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DatabaseError } from 'pg';
import { ORPCError } from '@orpc/server';
import { hashPassword } from 'better-auth/crypto';
import { findOneOrThrow } from '@openora/core/server';
import type { DrizzleService, DrizzleTx } from '@openora/core/server';
import type { User, UserCommands } from '@openora/core/contracts';
import { account, user } from '../schema/index.js';
import type { PlayEligibilityPublisher } from './play-eligibility.service.js';

export function isUniqueViolation(error: unknown, constraint: string): boolean {
  const cause = error instanceof DatabaseError ? error : (error as Error)?.cause;
  return (
    cause instanceof DatabaseError && cause.code === '23505' && cause.constraint === constraint
  );
}

export const generatedAdminUsername = () => `admin_${randomBytes(6).toString('hex')}`;

export class DrizzleUserCommands implements UserCommands {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly playEligibility: PlayEligibilityPublisher,
  ) {}

  publishPlayEligibility(userId: User['id'], tx: unknown) {
    return this.playEligibility.publish(tx as DrizzleTx, userId);
  }

  async setUsername(userId: User['id'], username: string, tx?: unknown) {
    const db = tx === undefined ? this.drizzle.db : (tx as DrizzleTx);
    try {
      await db.update(user).set({ username, name: username }).where(eq(user.id, userId));
    } catch (error) {
      if (isUniqueViolation(error, 'user_username_unique')) {
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
