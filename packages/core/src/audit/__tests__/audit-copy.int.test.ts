import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi, afterAll } from 'vitest';
import { Pool } from 'pg';
import { migrate as migrateOutbox } from '@openora/core/server/migrate';
import { DrizzleService, type DrizzleDb } from '@openora/core/server';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { adminDatabaseUrl, testDatabasePrefix } from '../../testing/real-infra.js';
import { migrate } from '../migrate.js';
import {
  appendAuditEntries,
  enqueueAuditInTransaction,
  verifyAuditChain,
} from '../service/audit.service.js';
import { main as runCopy, type CopyHooks } from '../service/audit-copy.service.js';

const unique = () => randomUUID().replaceAll('-', '');
const databases: string[] = [];
const roles: string[] = [];
const mains: TestDb[] = [];
const track = (main: TestDb) => {
  mains.push(main);
  databases.push(new URL(main.url).pathname.slice(1));
};
const services: DrizzleService[] = [];

const newDatabase = () => {
  const name = `${testDatabasePrefix()}copy_${unique()}`;
  databases.push(name);
  return name;
};
const newRole = () => {
  const name = `audit_copy_${unique().slice(0, 12)}`;
  roles.push(name);
  return { user: name, password: `pw-${randomUUID()}` };
};
const urlFor = (database: string, credentials?: { user: string; password: string }) => {
  const url = new URL(adminDatabaseUrl());
  url.pathname = `/${database}`;
  if (credentials) {
    url.username = credentials.user;
    url.password = credentials.password;
  }
  return url.toString();
};

async function sqlOn(url: string, ...statements: string[]): Promise<Record<string, string>[]> {
  const pool = new Pool({ connectionString: url });
  try {
    let rows: Record<string, string>[] = [];
    for (const statement of statements) {
      rows = (await pool.query(statement)).rows;
    }
    return rows;
  } finally {
    await pool.end();
  }
}
const asAdmin = (...statements: string[]) => sqlOn(adminDatabaseUrl(), ...statements);
const scalar = async (url: string, statement: string) =>
  Object.values((await sqlOn(url, statement))[0] ?? {})[0];

const serviceFor = (url: string) => {
  const service = new DrizzleService(url);
  services.push(service);
  return service.db;
};

afterAll(async () => {
  await Promise.all(services.map((service) => service.dispose()));
  await Promise.all(mains.map((main) => main.drop()));
  await asAdmin(
    ...databases.map((name) => `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
    ...roles.map((name) => `DROP ROLE IF EXISTS "${name}"`),
  );
});

const seed = async (db: DrizzleDb, count: number, tag = 'seed') => {
  const entries = Array.from({ length: count }, (_, index) => ({
    eventId: randomUUID(),
    entry: {
      actorType: 'system',
      action: 'test.copy',
      resourceType: 'player',
      resourceId: `${tag}-${index}`,
      after: { marker: index },
      correlationId: null,
      createdAt: new Date().toISOString(),
    },
  }));
  await db.transaction((tx) => appendAuditEntries(tx, entries));
};

type Fixture = { main: TestDb; target: string; targetUrl: string };

async function fixture({ migrateTarget = true } = {}): Promise<Fixture> {
  const main = await createTestDb([migrateOutbox, migrate]);
  track(main);
  const target = newDatabase();
  await asAdmin(`CREATE DATABASE "${target}"`);
  const targetUrl = urlFor(target);
  if (migrateTarget) {
    await migrateOutbox(targetUrl);
    await migrate(targetUrl);
  }
  return { main, target, targetUrl };
}

const envOf = (f: Fixture, extra: Record<string, string> = {}) => ({
  DATABASE_ADMIN_URL: f.main.url,
  AUDIT_DATABASE_URL: f.targetUrl,
  ...extra,
});

async function run(
  env: Record<string, string>,
  args: string[],
  hooks?: CopyHooks,
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  try {
    const code = await runCopy(args, env, hooks);
    return { code, out: out.join(''), err: err.join('') };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

const count = (url: string) => scalar(url, 'SELECT count(*)::text FROM audit_log');
const head = (url: string) =>
  sqlOn(url, 'SELECT seq::text, hash FROM audit_log ORDER BY audit_log.seq DESC LIMIT 1');
const sequenceState = (url: string) =>
  sqlOn(url, 'SELECT last_value::text, is_called::text FROM audit_log_seq_seq');
const fenceState = (url: string) =>
  scalar(url, `SELECT tgenabled::text FROM pg_trigger WHERE tgname = 'audit_log_moved'`);
const isValid = async (url: string) => (await verifyAuditChain(serviceFor(url))).valid;

const causeOf = (err: unknown): string =>
  err instanceof Error ? `${err.message} ${err.cause ? causeOf(err.cause) : ''}` : String(err);

const FAIL_AT_1500 = [
  `CREATE FUNCTION fail_at_1500() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN IF NEW.seq = 1500 THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$`,
  `CREATE TRIGGER fail_at_1500 BEFORE INSERT ON audit_log
     FOR EACH ROW EXECUTE FUNCTION fail_at_1500()`,
];

describe('audit-copy', () => {
  it('TC-1 copies a 2500 row chain, verifies it and lets the target append on', async () => {
    const f = await fixture();
    await seed(f.main.drizzle.db, 2500);
    const result = await run(envOf(f), ['--apply']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('rows copied: 2500');
    expect(await count(f.targetUrl)).toBe('2500');
    expect(await head(f.targetUrl)).toEqual(await head(f.main.url));
    expect(await isValid(f.targetUrl)).toBe(true);
    await seed(serviceFor(f.targetUrl), 1, 'later');
    expect((await head(f.targetUrl))[0]?.['seq']).toBe('2501');
    expect(await isValid(f.targetUrl)).toBe(true);
  });

  it('TC-2 a rerun copies nothing', async () => {
    const f = await fixture();
    await seed(f.main.drizzle.db, 5);
    await run(envOf(f), ['--apply']);
    const before = await head(f.targetUrl);
    const result = await run(envOf(f), ['--apply']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('rows copied: 0');
    expect(await count(f.targetUrl)).toBe('5');
    expect(await head(f.targetUrl)).toEqual(before);
  });

  it('TC-3 a batch that fails rolls back alone and the rerun finishes the copy', async () => {
    const f = await fixture();
    await seed(f.main.drizzle.db, 2500);
    await sqlOn(f.targetUrl, ...FAIL_AT_1500);
    const failed = await run(envOf(f), ['--apply']);
    expect(failed.code).toBe(1);
    expect(failed.err).toContain('injected failure');
    expect(await count(f.targetUrl)).toBe('1000');
    expect((await sequenceState(f.targetUrl))[0]?.['last_value']).toBe('1000');
    await sqlOn(f.targetUrl, 'DROP TRIGGER fail_at_1500 ON audit_log');
    const rerun = await run(envOf(f), ['--apply']);
    expect(rerun.code).toBe(0);
    expect(await count(f.targetUrl)).toBe('2500');
    expect(await isValid(f.targetUrl)).toBe(true);
  });

  it('TC-4 refuses a target that is ahead of the source and writes nothing', async () => {
    const f = await fixture();
    await seed(f.main.drizzle.db, 3);
    await seed(serviceFor(f.targetUrl), 5, 'other');
    const before = await head(f.targetUrl);
    const result = await run(envOf(f), ['--apply']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('target diverged from source at seq 5');
    expect(await count(f.targetUrl)).toBe('5');
    expect(await head(f.targetUrl)).toEqual(before);
  });

  it('TC-5 refuses a forged target row and reports a tampered source row', async () => {
    const forged = await fixture();
    await seed(forged.main.drizzle.db, 3);
    await seed(serviceFor(forged.targetUrl), 1, 'forged');
    const refused = await run(envOf(forged), ['--apply']);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('diverged from source at seq 1');
    expect(await count(forged.targetUrl)).toBe('1');

    const tampered = await fixture();
    await seed(tampered.main.drizzle.db, 4);
    await sqlOn(
      tampered.main.url,
      'ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only',
      `UPDATE audit_log SET action = 'tampered' WHERE seq = 2`,
    );
    const result = await run(envOf(tampered), ['--apply']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('broken at seq 2');
  });

  it('TC-6 a dry run counts and writes nothing', async () => {
    const f = await fixture();
    await seed(f.main.drizzle.db, 1500);
    const before = await sequenceState(f.targetUrl);
    const result = await run(envOf(f), []);
    expect(result.code).toBe(0);
    expect(result.out).toContain('rows copied: 1500');
    expect(await count(f.targetUrl)).toBe('0');
    expect(await sequenceState(f.targetUrl)).toEqual(before);
  });

  it('TC-7 the fence copies the delta, matches the heads and refuses legacy inserts', async () => {
    const f = await fixture();
    await seed(f.main.drizzle.db, 10);
    await run(envOf(f), ['--apply']);
    await seed(f.main.drizzle.db, 5, 'late');
    const result = await run(envOf(f), ['--fence', '--apply']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('rows copied: 5');
    expect(await head(f.targetUrl)).toEqual(await head(f.main.url));
    expect(await isValid(f.targetUrl)).toBe(true);
    expect(await fenceState(f.main.url)).toBe('A');
    const insert = `INSERT INTO audit_log (actor_type, action, resource_type, hash)
                    VALUES ('system', 'x', 'y', 'h')`;
    await expect(sqlOn(f.main.url, insert)).rejects.toThrow(/audit_log moved/);
    await expect(
      sqlOn(f.main.url, `SET session_replication_role = replica; ${insert}`),
    ).rejects.toThrow(/audit_log moved/);
  });

  it('TC-8 the fence rerun copies nothing and keeps the trigger', async () => {
    const f = await fixture();
    await seed(f.main.drizzle.db, 4);
    await run(envOf(f), ['--fence', '--apply']);
    const result = await run(envOf(f), ['--fence', '--apply']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('rows copied: 0');
    expect(await fenceState(f.main.url)).toBe('A');
  });

  it('TC-9a the fence gives up on a writer holding the chain and the rerun copies its row', async () => {
    const f = await fixture();
    await seed(f.main.drizzle.db, 3);
    await run(envOf(f), ['--apply']);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const writer = f.main.drizzle.db.transaction(async (tx) => {
      await appendAuditEntries(tx, [
        {
          eventId: randomUUID(),
          entry: {
            actorType: 'system',
            action: 'test.held',
            resourceType: 'player',
            correlationId: null,
            createdAt: new Date().toISOString(),
          },
        },
      ]);
      ready();
      await gate;
    });
    await holding;
    const blocked = await run(envOf(f), ['--fence', '--apply']);
    expect(blocked.code).toBe(1);
    expect(blocked.err).toContain('lock timeout');
    expect(await fenceState(f.main.url)).toBeUndefined();
    expect(await count(f.targetUrl)).toBe('3');
    release();
    await writer;
    const rerun = await run(envOf(f), ['--fence', '--apply']);
    expect(rerun.code).toBe(0);
    expect(rerun.out).toContain('rows copied: 1');
  }, 60_000);

  it('TC-9b a writer queued behind the fence fails once it commits', async () => {
    const f = await fixture();
    await seed(f.main.drizzle.db, 3);
    let queued: Promise<unknown> = Promise.resolve();
    const afterCopy = async () => {
      queued = seed(f.main.drizzle.db, 1, 'queued').catch((err: unknown) => err);
      for (;;) {
        const waiting = await scalar(
          f.main.url,
          `SELECT count(*)::text FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
        );
        if (waiting !== '0') {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    const result = await run(envOf(f), ['--fence', '--apply'], { afterCopy });
    expect(result.code).toBe(0);
    expect(causeOf(await queued)).toContain('audit_log moved');
    expect(await count(f.main.url)).toBe(await count(f.targetUrl));
  });

  it('TC-10 a crash before the main commit leaves no fence and the rerun finishes', async () => {
    const f = await fixture();
    await seed(f.main.drizzle.db, 5);
    const crashed = await run(envOf(f), ['--fence', '--apply'], {
      afterCopy: () => Promise.reject(new Error('crash after the copy')),
    });
    expect(crashed.code).toBe(1);
    expect(await fenceState(f.main.url)).toBeUndefined();
    expect(await count(f.targetUrl)).toBe('5');
    await seed(f.main.drizzle.db, 2, 'after');
    const rerun = await run(envOf(f), ['--fence', '--apply']);
    expect(rerun.code).toBe(0);
    expect(rerun.out).toContain('rows copied: 2');
    expect(await fenceState(f.main.url)).toBe('A');
  });

  it('TC-11 drain-outbox lifts the fence and ships the outbox into the legacy chain', async () => {
    const main = await createTestDb([migrateOutbox, migrate]);
    track(main);
    await seed(main.drizzle.db, 4);
    const targetName = newDatabase();
    const writer = newRole();
    const shipper = newRole();
    const targetUrl = urlFor(targetName, writer);
    const shipperUrl = urlFor(new URL(main.url).pathname.slice(1), shipper);
    await migrate({ adminUrl: main.url, auditUrl: targetUrl, shipperUrl });
    const env = {
      DATABASE_ADMIN_URL: main.url,
      AUDIT_DATABASE_URL: targetUrl,
      AUDIT_SHIPPER_DATABASE_URL: shipperUrl,
    };
    expect((await run(env, ['--fence', '--apply'])).code).toBe(0);
    for (const marker of ['a', 'b', 'c']) {
      await main.drizzle.db.transaction((tx) =>
        enqueueAuditInTransaction(tx, {
          actorType: 'system',
          action: 'test.outbox',
          resourceType: 'player',
          resourceId: marker,
        }),
      );
    }
    const result = await run(env, ['--drain-outbox', '--apply']);
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(await fenceState(main.url)).toBeUndefined();
    expect(await count(main.url)).toBe('7');
    expect(await scalar(main.url, 'SELECT count(*)::text FROM audit_outbox')).toBe('0');
    expect(await isValid(main.url)).toBe(true);
  }, 60_000);

  it('TC-12 drain-outbox refuses once the audit database is ahead and keeps the fence', async () => {
    const f = await fixture();
    await seed(f.main.drizzle.db, 3);
    await run(envOf(f), ['--fence', '--apply']);
    await seed(serviceFor(f.targetUrl), 1, 'after-switch');
    const result = await run(envOf(f), ['--drain-outbox', '--apply']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('roll forward only');
    expect(await fenceState(f.main.url)).toBe('A');
  });

  it('TC-13 refuses a missing table, different columns, one database and clashing flags', async () => {
    const bare = await fixture({ migrateTarget: false });
    await seed(bare.main.drizzle.db, 1);
    const missing = await run(envOf(bare), ['--apply']);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('run migrate with AUDIT_DATABASE_URL first');

    const f = await fixture();
    await seed(f.main.drizzle.db, 1);
    await sqlOn(f.targetUrl, 'ALTER TABLE audit_log ADD COLUMN extra text');
    const columns = await run(envOf(f), ['--apply']);
    expect(columns.code).toBe(1);
    expect(columns.err).toContain('different columns');
    expect(await count(f.targetUrl)).toBe('0');

    const same = await run({ ...envOf(f), AUDIT_DATABASE_URL: f.main.url }, ['--apply']);
    expect(same.code).toBe(1);
    const clash = await run(envOf(f), ['--fence', '--drain-outbox']);
    expect(clash.code).toBe(1);
    expect(clash.err).toContain('mutually exclusive');
  });

  it('TC-14 an empty legacy chain copies nothing, leaves the sequence and still fences', async () => {
    const f = await fixture();
    const before = await sequenceState(f.targetUrl);
    const copy = await run(envOf(f), ['--apply']);
    expect(copy.code).toBe(0);
    expect(copy.out).toContain('rows copied: 0');
    expect(await sequenceState(f.targetUrl)).toEqual(before);
    const fence = await run(envOf(f), ['--fence', '--apply']);
    expect(fence.code).toBe(0);
    expect(await fenceState(f.main.url)).toBe('A');
  });
});
