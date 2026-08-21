import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '@openora/core/server';
import { user } from '@openora/core/pam/schema/identity';
import type { TestApp } from './app.js';
import { registrationRequestHeaders } from './request.js';

export type RegisterPlayerInput = {
  email: string;
  password?: string;
  username?: string;
};

/** POST /identity/register with a unique handle and client IP. Does not verify the email. */
export async function submitRegistration(app: TestApp, input: RegisterPlayerInput) {
  return app.app.request('/identity/register', {
    method: 'POST',
    headers: registrationRequestHeaders(),
    body: JSON.stringify({
      email: input.email,
      password: input.password ?? 'password123',
      username: input.username ?? `player_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      acceptedTerms: true,
      acceptedAge: true,
    }),
  });
}

/** Marks an address verified, standing in for the click on the emailed link. */
export async function markEmailVerified(app: TestApp, userId: string) {
  await app.container
    .get(DRIZZLE)
    .db.update(user)
    .set({ emailVerified: true })
    .where(eq(user.id, userId));
}

/**
 * Registers a player and returns its user id. Sign-in requires a verified address,
 * so pass `verifyEmail: false` only when the test asserts on the unverified state.
 */
export async function registerPlayer(
  app: TestApp,
  input: RegisterPlayerInput & { verifyEmail?: boolean },
): Promise<string> {
  const res = await submitRegistration(app, input);
  if (!res.ok) {
    throw new Error(`register failed (${res.status}): ${await res.text()}`);
  }
  const [registered] = await app.container
    .get(DRIZZLE)
    .db.select({ id: user.id })
    .from(user)
    .where(eq(user.email, input.email.toLowerCase()));
  if (!registered) {
    throw new Error('registered user was not persisted');
  }
  if (input.verifyEmail !== false) {
    await markEmailVerified(app, registered.id);
  }
  return registered.id;
}
