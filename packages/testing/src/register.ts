import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '@openora/core/server';
import { user } from '@openora/core/pam/schema/identity';
import type { TestApp } from './app.js';
import { capturedEmailsFor } from './captured-emails.js';
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

/** The `token` query param better-auth put in the most recent verification email. */
export function verificationTokenFor(email: string): string {
  const [sent] = capturedEmailsFor(email);
  if (!sent) {
    throw new Error(`no verification email captured for ${email}`);
  }
  const token = /[?&]token=([^&\s"']+)/.exec(sent.body)?.[1];
  if (!token) {
    throw new Error(`no token in verification email for ${email}: ${sent.body}`);
  }
  return decodeURIComponent(token);
}

/**
 * Clicks the emailed verification link for real - the route consumes the token,
 * rate-limits, and emits `identity.email.verified`, none of which a direct
 * `email_verified` write would exercise.
 */
export async function verifyEmailByLink(app: TestApp, email: string) {
  const res = await app.app.request('/identity/email/verify', {
    method: 'POST',
    // Fresh client IP per click: the route buckets unauthenticated callers by IP.
    headers: registrationRequestHeaders(),
    body: JSON.stringify({ token: verificationTokenFor(email) }),
  });
  if (!res.ok) {
    throw new Error(`verify email failed (${res.status}): ${await res.text()}`);
  }
}

/** Escape hatch for tests that only need the verified state, not the route. */
export async function forceEmailVerified(app: TestApp, userId: string) {
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
    await verifyEmailByLink(app, input.email);
  }
  return registered.id;
}
