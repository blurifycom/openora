import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type Container, type CoreTokenCatalog } from '@openora/core/server';
import { user } from '@openora/core/pam/schema/identity';
import { adminRole, adminRoleAssignment } from '@openora/core/iam/schema';
import type { TestApp } from './app.js';
import type { TestClient } from './request.js';
import { registerAndMaterializePlayer, uniqueUsername } from './register.js';

// oxlint-disable-next-line typescript/no-explicit-any -- ad-hoc JSON shape assertions in tests
export async function readJson(res: Response): Promise<any> {
  return res.json();
}

/** A registered, session-holding player whose email is `<prefix>-<uuid>@e2e.test`. */
export function registerWithEmail(app: TestApp, prefix: string) {
  return registerAndMaterializePlayer(app, { email: `${prefix}-${randomUUID()}@e2e.test` });
}

export type Chatter = Awaited<ReturnType<typeof registerAndMaterializePlayer>> & {
  username: string;
};

/** A registered player with a unique, profanity-safe handle; the email derives from it. */
export async function registerChatter(
  app: TestApp,
  prefix: string,
  email?: string,
): Promise<Chatter> {
  const username = uniqueUsername(prefix);
  const registered = await registerAndMaterializePlayer(app, {
    email: email ?? `${username}@e2e.test`,
    username,
  });
  return { ...registered, username };
}

/** Admin override to an approved basic KYC tier. */
export async function verifyKyc(
  admin: TestClient,
  userId: string,
  reason = 'e2e fixture verification',
) {
  const res = await admin.post(`/compliance/players/${userId}/kyc/override`, {
    tier: 'basic',
    status: 'approved',
    reason,
  });
  if (res.status !== 200) {
    throw new Error(`verifyKyc failed (${res.status}): ${await res.text()}`);
  }
}

/** Admin assigns a manual player tag; returns the response body. */
export async function assignTag(
  admin: TestClient,
  playerId: string,
  tagKey: string,
  assignReason = 'e2e fixture',
) {
  const res = await admin.post(`/player/${playerId}/player-tag`, {
    tagKey,
    assignReason,
    assignActor: 'manual',
  });
  if (res.status !== 200) {
    throw new Error(`assignTag(${tagKey}) failed (${res.status}): ${await res.text()}`);
  }
  return readJson(res);
}

/**
 * Assigns a REAL DB-backed IAM role, bypassing the API (assignRole itself needs an existing
 * super-admin). AdminGuard gates on the coarse static `user.role` first, so a DB-backed role
 * needs BOTH `user.role = 'admin'` AND the `admin_role_assignment` row.
 */
export async function assignIamRoleByKey(
  container: Container<CoreTokenCatalog>,
  userId: string,
  roleKey: string,
) {
  const drizzle = container.get(DRIZZLE).db;
  await drizzle.update(user).set({ role: 'admin' }).where(eq(user.id, userId));
  const [role] = await drizzle.select().from(adminRole).where(eq(adminRole.key, roleKey));
  if (!role) {
    throw new Error(`assignIamRoleByKey: no seeded admin_role with key='${roleKey}'`);
  }
  await drizzle
    .insert(adminRoleAssignment)
    .values({ userId, roleId: role.id })
    .onConflictDoNothing();
}
