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
import { drainAuditOutbox } from '../service/audit-shipper.service.js';
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

type Fixture = {
  main: TestDb;
  target: string;
  targetUrl: string;
  auditUrl: string;
  shipperUrl: string;
};

async function fixture({ split = true, migrateTarget = true } = {}): Promise<Fixture> {
  const main = await createTestDb([migrateOutbox, migrate]);
  track(main);
  const target = newDatabase();
  const targetUrl = urlFor(target);
  const auditUrl = split ? urlFor(target, newRole()) : targetUrl;
  const shipperUrl = urlFor(new URL(main.url).pathname.slice(1), newRole());
  if (split) {
    await migrate({ adminUrl: main.url, auditUrl, shipperUrl });
  } else {
    await asAdmin(`CREATE DATABASE "${target}"`);
    if (migrateTarget) {
      await migrateOutbox(targetUrl);
      await migrate(targetUrl);
    }
  }
  return { main, target, targetUrl, auditUrl, shipperUrl };
}

const envOf = (f: Fixture) => ({
  DATABASE_ADMIN_URL: f.main.url,
  AUDIT_DATABASE_URL: f.auditUrl,
  AUDIT_SHIPPER_DATABASE_URL: f.shipperUrl,
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
const closedState = (url: string) =>
  scalar(url, `SELECT count(*)::text FROM pg_trigger WHERE tgname = 'audit_log_closed'`);
const isValid = async (url: string) => (await verifyAuditChain(serviceFor(url))).valid;

const causeOf = (err: unknown): string =>
  err instanceof Error ? `${err.message} ${err.cause ? causeOf(err.cause) : ''}` : String(err);

const queueOutbox = async (f: Fixture, markers: string[]) => {
  for (const marker of markers) {
    await f.main.drizzle.db.transaction((tx) =>
      enqueueAuditInTransaction(tx, {
        actorType: 'system',
        action: 'test.outbox',
        resourceType: 'player',
        resourceId: marker,
      }),
    );
  }
};

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
    expect(result.out).toContain('rows to copy: 1500');
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
    const f = await fixture();
    await seed(f.main.drizzle.db, 4);
    expect((await run(envOf(f), ['--fence', '--apply'])).code).toBe(0);
    await queueOutbox(f, ['a', 'b', 'c']);
    const result = await run(envOf(f), ['--drain-outbox', '--apply']);
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(await fenceState(f.main.url)).toBeUndefined();
    expect(await count(f.main.url)).toBe('7');
    expect(await scalar(f.main.url, 'SELECT count(*)::text FROM audit_outbox')).toBe('0');
    expect(await isValid(f.main.url)).toBe(true);
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
    const bare = await fixture({ split: false, migrateTarget: false });
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

  it('TC-15 a target chain that fails verification stops the fence before it commits', async () => {
    const f = await fixture();
    await seed(f.main.drizzle.db, 4);
    await sqlOn(
      f.main.url,
      'ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only',
      `UPDATE audit_log SET action = 'tampered' WHERE seq = 2`,
    );
    const result = await run(envOf(f), ['--fence', '--apply']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('broken at seq 2');
    expect(await fenceState(f.main.url)).toBeUndefined();
  });

  it('TC-16 drain-outbox refuses a split main without a shipper url and keeps the fence', async () => {
    const f = await fixture();
    await seed(f.main.drizzle.db, 3);
    await run(envOf(f), ['--fence', '--apply']);
    const { AUDIT_SHIPPER_DATABASE_URL: _omitted, ...withoutShipper } = envOf(f);
    const result = await run(withoutShipper, ['--drain-outbox', '--apply']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('AUDIT_SHIPPER_DATABASE_URL');
    expect(await fenceState(f.main.url)).toBe('A');
  });

  it('TC-17 the audit database is closed before the fence lifts, so a late append fails', async () => {
    const f = await fixture();
    await seed(f.main.drizzle.db, 3);
    await run(envOf(f), ['--fence', '--apply']);
    await queueOutbox(f, ['x']);
    let live: unknown;
    const duringDrain = async () => {
      live = await seed(serviceFor(f.targetUrl), 1, 'live').catch((err: unknown) => err);
    };
    const result = await run(envOf(f), ['--drain-outbox', '--apply'], { duringDrain });
    expect(result.code).toBe(0);
    expect(causeOf(live)).toContain('drained back into the main database');
    expect(await count(f.main.url)).toBe('4');
    expect(await count(f.targetUrl)).toBe('3');
    expect(await scalar(f.targetUrl, `SELECT hash FROM audit_log WHERE seq = 3`)).toBe(
      await scalar(f.main.url, `SELECT hash FROM audit_log WHERE seq = 3`),
    );
    expect(await scalar(f.main.url, `SELECT count(*)::text FROM audit_log WHERE seq = 4`)).toBe(
      '1',
    );
  }, 60_000);

  it('TC-18 the fence refuses a main database that is not split', async () => {
    const f = await fixture({ split: false });
    await seed(f.main.drizzle.db, 2);
    const result = await run(envOf(f), ['--fence', '--apply']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('not split');
    expect(await fenceState(f.main.url)).toBeUndefined();
  });

  it('TC-19 the fence dry run only counts and installs nothing', async () => {
    const f = await fixture();
    await seed(f.main.drizzle.db, 3);
    const result = await run(envOf(f), ['--fence']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('rows to copy: 3');
    expect(await count(f.targetUrl)).toBe('0');
    expect(await fenceState(f.main.url)).toBeUndefined();
  });

  it('TC-20 a bad flag prints the usage and never the argument', async () => {
    const f = await fixture({ split: false });
    const result = await run(envOf(f), ['--postgres://u:hunter2@h/d']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('usage: openora-audit-copy');
    expect(result.err).toBe('usage: openora-audit-copy [--apply] [--fence | --drain-outbox]\n');
    expect(result.err + result.out).not.toContain('hunter2');
  });

  it('TC-21 a killed connection ends the run with exit 1', async () => {
    const f = await fixture();
    await seed(f.main.drizzle.db, 3);
    const afterCopy = async () => {
      await asAdmin(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE application_name = 'openora-audit-copy' AND pid <> pg_backend_pid()`,
      );
    };
    const result = await run(envOf(f), ['--fence', '--apply'], { afterCopy });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/terminat|connection/i);
    expect(await fenceState(f.main.url)).toBeUndefined();
  });

  it('TC-22 an apply run prints the heads, counts and verdict as evidence', async () => {
    const f = await fixture();
    await seed(f.main.drizzle.db, 3);
    const result = await run(envOf(f), ['--apply']);
    const sourceHead = (await head(f.main.url))[0];
    expect(result.out).toContain(
      `source: rows=3 head=${sourceHead?.['seq']}:${sourceHead?.['hash']}`,
    );
    expect(result.out).toContain(
      `target: rows=3 head=${sourceHead?.['seq']}:${sourceHead?.['hash']}`,
    );
    expect(result.out).toContain('verify target: valid');
  });

  it('TC-23 the fence verifies the target before the lock and only the new rows under it', async () => {
    const f = await fixture();
    await seed(f.main.drizzle.db, 10);
    await run(envOf(f), ['--apply']);
    await seed(f.main.drizzle.db, 5, 'late');
    const result = await run(envOf(f), ['--fence', '--apply']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('verify target before lock: valid (full chain)');
    expect(result.out).toContain('verify target: valid (from seq 10)');
  });

  it('TC-24 a copy beside a running drain is refused by the closed audit database', async () => {
    const f = await fixture();
    await seed(f.main.drizzle.db, 3);
    await run(envOf(f), ['--fence', '--apply']);
    let beside = -1;
    const duringDrain = async () => {
      beside = await runCopy(['--apply'], envOf(f));
    };
    const result = await run(envOf(f), ['--drain-outbox', '--apply'], { duringDrain });
    expect(result.code).toBe(0);
    expect(beside).toBe(1);
    expect(result.err).toContain('drained back into the main database');
  }, 60_000);

  it('TC-25 a drain that fails after the fence is lifted reruns cleanly', async () => {
    const f = await fixture();
    await seed(f.main.drizzle.db, 3);
    await run(envOf(f), ['--fence', '--apply']);
    await queueOutbox(f, ['y', 'z']);
    const failed = await run(envOf(f), ['--drain-outbox', '--apply'], {
      afterFenceLift: () => Promise.reject(new Error('crash after the lift')),
    });
    expect(failed.code).toBe(1);
    expect(await fenceState(f.main.url)).toBeUndefined();
    expect(await closedState(f.targetUrl)).toBe('1');
    const rerun = await run(envOf(f), ['--drain-outbox', '--apply']);
    expect(rerun.code).toBe(0);
    expect(await count(f.main.url)).toBe('5');
    expect(await scalar(f.main.url, 'SELECT count(*)::text FROM audit_outbox')).toBe('0');
    expect(await isValid(f.main.url)).toBe(true);
  }, 60_000);

  it('TC-26 a drain refuses while a shipper holds its lock and keeps the fence', async () => {
    const f = await fixture();
    await seed(f.main.drizzle.db, 3);
    await run(envOf(f), ['--fence', '--apply']);
    const holder = new Pool({ connectionString: f.main.url, max: 1 });
    const client = await holder.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('audit_shipper'))`);
      const result = await run(envOf(f), ['--drain-outbox', '--apply']);
      expect(result.code).toBe(1);
      expect(result.err).toContain('shipper holds the shipper lock');
      expect(await fenceState(f.main.url)).toBe('A');
      expect(await closedState(f.targetUrl)).toBe('0');
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await holder.end();
    }
  });

  it('TC-27 a shipper that starts after the idle check fails on the closed audit database and its rows ship on the rerun', async () => {
    const f = await fixture();
    await seed(f.main.drizzle.db, 3);
    await run(envOf(f), ['--fence', '--apply']);
    await queueOutbox(f, ['p', 'q']);
    let late: unknown;
    const duringDrain = async () => {
      late = await drainAuditOutbox(serviceFor(f.shipperUrl), serviceFor(f.auditUrl)).catch(
        (err: unknown) => err,
      );
    };
    const first = await run(envOf(f), ['--drain-outbox', '--apply'], { duringDrain });
    expect(causeOf(late)).toContain('drained back into the main database');
    expect(first.code).toBe(0);
    expect(await count(f.main.url)).toBe('5');
    expect(await scalar(f.main.url, 'SELECT count(*)::text FROM audit_outbox')).toBe('0');
    expect(await count(f.targetUrl)).toBe('3');
    const rerun = await run(envOf(f), ['--drain-outbox', '--apply']);
    expect(rerun.code).toBe(0);
    expect(await count(f.main.url)).toBe('5');
    expect(await isValid(f.main.url)).toBe(true);
  }, 60_000);

  it('TC-28 a drain that leaves rows in the outbox exits 1', async () => {
    const f = await fixture();
    await seed(f.main.drizzle.db, 3);
    await run(envOf(f), ['--fence', '--apply']);
    const result = await run(envOf(f), ['--drain-outbox', '--apply'], {
      afterDrain: () => queueOutbox(f, ['unstopped']),
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain('audit_outbox still holds rows');
    const rerun = await run(envOf(f), ['--drain-outbox', '--apply']);
    expect(rerun.code).toBe(0);
  }, 60_000);

  it('TC-29 a failure between the chain insert and the outbox delete never duplicates a row', async () => {
    const f = await fixture();
    await seed(f.main.drizzle.db, 3);
    await run(envOf(f), ['--fence', '--apply']);
    await queueOutbox(f, ['once']);
    await sqlOn(
      f.main.url,
      `CREATE FUNCTION fail_outbox_delete() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RAISE EXCEPTION 'injected delete failure'; END $$`,
      `CREATE TRIGGER fail_outbox_delete BEFORE DELETE ON audit_outbox
         FOR EACH ROW EXECUTE FUNCTION fail_outbox_delete()`,
    );
    const failed = await run(envOf(f), ['--drain-outbox', '--apply']);
    expect(failed.code).toBe(1);
    expect(failed.err).toContain('delete from "audit_outbox"');
    expect(await count(f.main.url)).toBe('4');
    expect(await scalar(f.main.url, 'SELECT count(*)::text FROM audit_outbox')).toBe('1');
    await sqlOn(f.main.url, 'DROP TRIGGER fail_outbox_delete ON audit_outbox');
    const rerun = await run(envOf(f), ['--drain-outbox', '--apply']);
    expect(rerun.code).toBe(0);
    expect(await count(f.main.url)).toBe('4');
    expect(
      await scalar(
        f.main.url,
        'SELECT (count(event_id) - count(DISTINCT event_id))::text FROM audit_log',
      ),
    ).toBe('0');
    expect(await scalar(f.main.url, 'SELECT count(*)::text FROM audit_outbox')).toBe('0');
    expect(await isValid(f.main.url)).toBe(true);
  }, 60_000);

  it('TC-30 a drain that sets a row aside as rejected exits 1', async () => {
    const f = await fixture();
    await seed(f.main.drizzle.db, 3);
    await run(envOf(f), ['--fence', '--apply']);
    await sqlOn(
      f.main.url,
      `INSERT INTO audit_outbox (event_id, entry) VALUES (gen_random_uuid(), '{"bad": true}'::jsonb)`,
    );
    const result = await run(envOf(f), ['--drain-outbox', '--apply']);
    expect(result.code).toBe(1);
    expect(result.err).toContain(
      '1 outbox rows rejected during drain; inspect audit_outbox_rejected',
    );
    expect(await scalar(f.main.url, 'SELECT count(*)::text FROM audit_outbox_rejected')).toBe('1');
  }, 60_000);
});
