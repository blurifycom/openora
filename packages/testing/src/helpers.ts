import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { and, eq, like, sql } from 'drizzle-orm';
import {
  DRIZZLE,
  eventOutbox,
  processedEvents,
  type Container,
  type CoreTokenCatalog,
} from '@openora/core/server';
import { user } from '@openora/core/pam/schema/identity';
import { walletTransaction } from '@openora/core/wallet/schema';
import { adminRole, adminRoleAssignment } from '@openora/core/iam/schema';
import type { TestApp } from './app.js';
import type { TestClient } from './request.js';
import { registerAndMaterializePlayer, uniqueUsername } from './register.js';

// oxlint-disable-next-line typescript/no-explicit-any -- ad-hoc JSON shape assertions in tests
export async function readJson(res: Response): Promise<any> {
  return res.json();
}

export type NamedAccount = Awaited<ReturnType<typeof registerAndMaterializePlayer>> & {
  name: string;
  email: string;
};

/** A registered player whose `user.name` is set to `name`; the email starts with `emailPrefix`. */
export async function newPlayer(
  app: TestApp,
  emailPrefix: string,
  name = `player ${randomUUID()}`,
): Promise<NamedAccount> {
  const email = `${emailPrefix}-${randomUUID()}@e2e.test`;
  const account = await registerAndMaterializePlayer(app, { email });
  await app.container.get(DRIZZLE).db.update(user).set({ name }).where(eq(user.id, account.userId));
  return { ...account, name, email };
}

export async function newStaff(
  app: TestApp,
  emailPrefix: string,
  roleKey: string,
  name = `staff ${randomUUID()}`,
): Promise<NamedAccount> {
  const account = await newPlayer(app, emailPrefix, name);
  await assignIamRoleByKey(app.container, account.userId, roleKey);
  return account;
}

export async function deactivateUser(app: TestApp, userId: string) {
  await app.container
    .get(DRIZZLE)
    .db.update(user)
    .set({ isActive: false })
    .where(eq(user.id, userId));
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
  const roleId = await roleIdByKey(container, roleKey);
  await drizzle.insert(adminRoleAssignment).values({ userId, roleId }).onConflictDoNothing();
}

/** The id of the seeded `admin_role` with key `roleKey`; throws when there is none. */
export async function roleIdByKey(
  container: Container<CoreTokenCatalog>,
  roleKey: string,
): Promise<string> {
  const [role] = await container
    .get(DRIZZLE)
    .db.select({ id: adminRole.id })
    .from(adminRole)
    .where(eq(adminRole.key, roleKey));
  if (!role) {
    throw new Error(`no seeded admin_role with key='${roleKey}'`);
  }
  return role.id;
}

const SCREENING_TIMEOUT_MS = 10_000;

/**
 * Waits until the wallet handled the tag module's screening verdict for a withdrawal, which is
 * what runs auto-approval (ADR-0057), then returns the withdrawal's status as that decided it.
 */
export async function screenedWithdrawalStatus(app: TestApp, transactionId: string) {
  const { db } = app.container.get(DRIZZLE);
  const deadline = Date.now() + SCREENING_TIMEOUT_MS;
  for (;;) {
    const handled = await db
      .select({ eventId: processedEvents.eventId })
      .from(processedEvents)
      .innerJoin(eventOutbox, eq(eventOutbox.eventId, processedEvents.eventId))
      .where(
        and(
          eq(eventOutbox.topic, 'tag.withdrawal.screened'),
          sql`${eventOutbox.payload}->>'transactionId' = ${transactionId}`,
          like(processedEvents.consumer, '%/wallet/tag.withdrawal.screened%'),
        ),
      )
      .limit(1);
    if (handled.length > 0) {
      break;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `withdrawal ${transactionId} was not screened within ${SCREENING_TIMEOUT_MS}ms`,
      );
    }
    await delay(50);
  }
  const [row] = await db
    .select({ status: walletTransaction.status })
    .from(walletTransaction)
    .where(eq(walletTransaction.id, transactionId));
  return row?.status;
}
