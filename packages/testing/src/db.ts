import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
// Every module owns its own migration tracking table + history (ADR-0027) - a full
// test DB must apply all of them or integration tests hit "relation does not exist".
// `server/migrate` covers only the engine-owned `outbox` table; everything else is a
// domain module. Keep this list in sync with `packages/core/src/**/migrate.ts`.
import { migrate as migrateOutbox } from '@openora/core/server/migrate';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { migrate as migrateTag } from '@openora/core/pam/migrate/tag';
import { migrate as migrateAudit } from '@openora/core/audit/migrate';
import { migrate as migrateIam } from '@openora/core/iam/migrate';
import { migrate as migrateCms } from '@openora/core/cms/migrate';
import { migrate as migrateCompliance } from '@openora/core/compliance/migrate';
import { migrate as migrateWallet } from '@openora/core/wallet/migrate';
import { migrate as migrateGaming } from '@openora/core/casino/migrate/gaming';
import { migrate as migrateLobby } from '@openora/core/casino/migrate/lobby';
import { migrate as migrateChat } from '@openora/core/engagement/migrate/chat';
import { migrate as migrateChatCommands } from '@openora/core/engagement/migrate/chat-commands';
import { migrate as migrateNotifications } from '@openora/core/engagement/migrate/notifications';
import { migrate as migrateSocial } from '@openora/core/engagement/migrate/social';
import { migrate as migrateExchangeRate } from '@openora/core/fx/migrate/exchange-rate';

const DEFAULT_TEST_URL = 'postgres://postgres:postgres@localhost:5432/oss_igaming_test';

async function applyAllMigrations(url: string): Promise<void> {
  // No cross-module FKs (db-conventions), so order is only for readability.
  await migrateOutbox(url);
  await migrateIdentity(url);
  await migrateProfile(url);
  await migrateTag(url);
  await migrateAudit(url);
  await migrateIam(url);
  await migrateCms(url);
  await migrateCompliance(url);
  await migrateWallet(url);
  await migrateGaming(url);
  await migrateLobby(url);
  await migrateChat(url);
  await migrateChatCommands(url);
  await migrateNotifications(url);
  await migrateSocial(url);
  await migrateExchangeRate(url);
}

export async function applyMigrations(url: string): Promise<void> {
  await applyAllMigrations(url);
}

const TEMPLATE_PREFIX = 'oss_igaming_test_tpl';

/**
 * A run's databases carry its own id, so two runs against one Postgres server (a second
 * worktree, a stray `vitest` alongside `pnpm verify`) neither share a template nor sweep
 * each other's clones in teardown.
 *
 * `global-setup.ts` sets this before vitest forks its workers, which inherit it. A worker
 * that somehow did not would otherwise create databases under a name the teardown never
 * looks for, so an absent id is an error rather than a default.
 */
export function testRunId(): string {
  const id = process.env['OPENORA_TEST_RUN_ID'];
  if (!id) {
    throw new Error('OPENORA_TEST_RUN_ID is not set - this tier requires its global setup');
  }
  return id;
}

/** The migrated database `global-setup.ts` builds once per run; every suite clones it. */
export const templateDatabase = (): string => `${TEMPLATE_PREFIX}_${testRunId()}`;

const testUrl = () => process.env['TEST_DATABASE_URL'] ?? DEFAULT_TEST_URL;

/** The same server and credentials as TEST_DATABASE_URL, pointed at `database`. */
export function urlForDatabase(database: string): string {
  const url = new URL(testUrl());
  url.pathname = `/${database}`;
  return url.toString();
}

/** A connection for CREATE/DROP DATABASE, which cannot run against their own target. */
export const adminUrl = (): string => urlForDatabase('postgres');

export type TestDb = {
  /** The connection string the app under test must use. */
  url: string;
  /** Close the pool. The database itself is dropped by the global teardown. */
  dispose(): Promise<void>;
};

/**
 * Clone the migrated template into a database of this suite's own and hand back a `url`
 * to point the app at.
 *
 * A database per suite is what lets this tier run its files in parallel: they seed
 * players, wallets and rooms under fixed ids and would otherwise read each other's rows.
 * Cloning rather than migrating keeps that affordable - `CREATE DATABASE ... TEMPLATE`
 * is a file copy, around 50ms, against roughly 250ms of migration checks per suite.
 *
 * `TEST_DATABASE_URL` selects the server; the database it names is not otherwise used.
 */
export async function setupTestDb(): Promise<TestDb> {
  const template = templateDatabase();
  const database = `${template}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = new Pool({ connectionString: adminUrl(), connectionTimeoutMillis: 5000 });
  try {
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE "${template}"`);
  } finally {
    await admin.end();
  }

  const url = urlForDatabase(database);
  const pool = new Pool({ connectionString: url });

  return {
    url,
    async dispose() {
      await pool.end();
    },
  };
}
