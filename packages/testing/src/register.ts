import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '@openora/core/server';
import { user } from '@openora/core/pam/schema/identity';
import type { TestApp } from './app.js';
import { capturedEmailsFor } from './captured-emails.js';
import { asPlayer, registrationRequestHeaders, type TestClient } from './request.js';

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

/** The 6-digit code in the most recent verification email. */
export function verificationOtpFor(email: string): string {
  const [sent] = capturedEmailsFor(email);
  if (!sent) {
    throw new Error(`no verification email captured for ${email}`);
  }
  const otp = /\b(\d{6})\b/.exec(sent.body)?.[1];
  if (!otp) {
    throw new Error(`no verification code in email for ${email}: ${sent.body}`);
  }
  return otp;
}

/**
 * Enters the emailed code for real - the route consumes the OTP, rate-limits, mints the
 * session and emits `identity.email.verified`, none of which a direct `email_verified`
 * write would exercise. Returns the response so callers can assert on the session.
 */
export async function verifyEmailByOtp(app: TestApp, email: string) {
  const res = await app.app.request('/identity/email/verify', {
    method: 'POST',
    // Fresh client IP per attempt: the route also buckets callers by IP.
    headers: registrationRequestHeaders(),
    body: JSON.stringify({ email, otp: verificationOtpFor(email) }),
  });
  if (!res.ok) {
    throw new Error(`verify email failed (${res.status}): ${await res.text()}`);
  }
  return res;
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
 * Registers a player and returns its user id. Verification is what mints the first
 * session, so pass `verifyEmail: false` only when the test asserts on the unverified state.
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
    await verifyEmailByOtp(app, input.email);
  }
  return registered.id;
}

/**
 * Registers, verifies, signs in, and materialises the PAM `player` row (the profile
 * route is get-or-create), so downstream modules resolve a real `player.id` - the
 * audit trail's `resolvePlayerId` needs one.
 */
export async function registerAndMaterializePlayer(
  app: TestApp,
  input: RegisterPlayerInput,
): Promise<{ client: TestClient; userId: string; playerId: string }> {
  const userId = await registerPlayer(app, input);
  const client = await asPlayer(app.app, {
    email: input.email,
    ...(input.password ? { password: input.password } : {}),
  });
  const profileRes = await client.get('/profile');
  if (!profileRes.ok) {
    throw new Error(
      `profile materialize failed (${profileRes.status}): ${await profileRes.text()}`,
    );
  }
  const { id: playerId } = (await profileRes.json()) as { id: string };
  return { client, userId, playerId };
}
