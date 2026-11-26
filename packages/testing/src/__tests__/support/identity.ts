import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import * as z from 'zod';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { session, user } from '@openora/core/pam/schema/identity';
import {
  asAdmin,
  bootE2e,
  registerAndMaterializePlayer,
  registrationRequestHeaders,
  type BootE2eOptions,
  type E2e,
  type TestClient,
} from '../../index.js';

const pluginPath = (file: string) => fileURLToPath(new URL(file, import.meta.url));

export const PASSWORD = 'password1234';
export const WRONG_PASSWORD = 'definitely-wrong-1';

export type IdentityE2e = E2e & { admin: TestClient };

export async function bootIdentityE2e(
  extraPlugins: NonNullable<BootE2eOptions['plugins']> = [],
): Promise<IdentityE2e> {
  const e2e = await bootE2e({ plugins: [...(await loadExtensions()), ...extraPlugins] });
  return { ...e2e, admin: await asAdmin(e2e.app.app) };
}

export const smsCapturePlugin = {
  id: 'testing-sms-capture',
  path: pluginPath('./test-sms-capture-plugin.ts'),
};

export const ErrorBodySchema = z.object({
  code: z.string(),
  status: z.number(),
  message: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const LoginSuccessSchema = z.object({
  user: z.object({ id: z.string(), email: z.string() }),
  session: z.object({ token: z.string(), expiresAt: z.string() }),
  security: z.object({ attemptsRemaining: z.number(), lockoutUntil: z.string().nullable() }),
});

export const LockedDataSchema = z.object({
  code: z.literal('ACCOUNT_LOCKED'),
  attemptsRemaining: z.literal(0),
  lockoutUntil: z.string(),
});

export const uniqueEmail = (prefix: string) => `${prefix}-${randomUUID()}@e2e.test`;

export async function newCredentialPlayer(e2e: E2e, prefix: string) {
  const email = uniqueEmail(prefix);
  const account = await registerAndMaterializePlayer(e2e.app, { email });
  return { ...account, email, password: PASSWORD };
}

export async function postJson(
  e2e: E2e,
  path: string,
  body: unknown,
  headers?: Record<string, string>,
) {
  const merged = new Headers(registrationRequestHeaders());
  new Headers(headers).forEach((value, key) => merged.set(key, value));
  const res = await e2e.app.app.request(path, {
    method: 'POST',
    headers: merged,
    body: JSON.stringify(body),
  });
  const parsed: unknown = await res.json().catch(() => null);
  return { res, status: res.status, body: parsed };
}

export type LoginExtras = { audience?: 'staff' | 'player'; rememberMe?: boolean };

export const login = (e2e: E2e, email: string, password: string, extras: LoginExtras = {}) =>
  postJson(e2e, '/identity/login', { email, password, ...extras });

export function errorOf(body: unknown) {
  return ErrorBodySchema.parse(body);
}

export async function failLogins(e2e: E2e, email: string, count: number) {
  const results = [];
  for (let i = 0; i < count; i++) {
    results.push(await login(e2e, email, WRONG_PASSWORD));
  }
  return results;
}

export async function userRow(e2e: E2e, userId: string) {
  const [row] = await e2e.app.container
    .get(DRIZZLE)
    .db.select()
    .from(user)
    .where(eq(user.id, userId));
  if (!row) {
    throw new Error(`no user ${userId}`);
  }
  return row;
}

export async function liveSessionCount(e2e: E2e, userId: string) {
  const rows = await e2e.app.container
    .get(DRIZZLE)
    .db.select({ expiresAt: session.expiresAt })
    .from(session)
    .where(eq(session.userId, userId));
  return rows.filter((row) => row.expiresAt.getTime() > Date.now()).length;
}

export async function expireLockout(e2e: E2e, userId: string) {
  await e2e.app.container
    .get(DRIZZLE)
    .db.update(user)
    .set({ lockoutUntil: new Date(Date.now() - 1000) })
    .where(eq(user.id, userId));
}
