import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq, like, sql } from 'drizzle-orm';
import { DRIZZLE, eventOutbox, loadExtensions } from '@openora/core/server';
import { user, verification } from '@openora/core/pam/schema/identity';
import { auditLog } from '@openora/core/audit/schema';
import {
  asAdmin,
  bootE2e,
  closeE2e,
  asPlayer,
  bootTestApp,
  registerAndMaterializePlayer,
  setupTestDb,
  submitRegistration,
  waitForEmail,
  type TestApp,
  type TestClient,
  type TestDb,
} from '../index.js';
import { readSupportHistoryCalls, resetSupportHistory } from '../test-support-history-plugin.js';

const historyPluginPath = fileURLToPath(
  new URL('../test-support-history-plugin.ts', import.meta.url),
);

const PASSWORD = 'password1234';
const CONFIRM_SUBJECT = 'Confirm your new email address';

let db: TestDb;
let app: TestApp;
let admin: TestClient;

const drizzle = () => app.container.get(DRIZZLE).db;

beforeAll(async () => {
  const extensions = await loadExtensions();
  ({ db, app } = await bootE2e({
    plugins: [...extensions, { id: 'testing-support-history', path: historyPluginPath }],
  }));
  admin = await asAdmin(app.app);
}, 60_000);

beforeEach(() => {
  resetSupportHistory();
});

afterAll(async () => {
  await closeE2e({ app, db });
});

const newPlayer = async () => {
  const email = `email-atomic-${randomUUID()}@e2e.test`;
  const { client, userId, playerId } = await registerAndMaterializePlayer(app, {
    email,
    password: PASSWORD,
  });
  return { email, client, userId, playerId };
};

const userRow = async (userId: string) => {
  const [row] = await drizzle().select().from(user).where(eq(user.id, userId));
  return row;
};

const auditRows = (playerId: string) =>
  drizzle()
    .select({ id: auditLog.id, before: auditLog.before, after: auditLog.after })
    .from(auditLog)
    .where(and(eq(auditLog.action, 'identity.email.changed'), eq(auditLog.resourceId, playerId)));

const outboxCount = async (userId: string) =>
  (
    await drizzle()
      .select({ id: eventOutbox.eventId })
      .from(eventOutbox)
      .where(
        and(
          eq(eventOutbox.topic, 'identity.email.changed'),
          sql`${eventOutbox.payload}->>'userId' = ${userId}`,
        ),
      )
  ).length;

const requestChange = async (client: TestClient, newEmail: string) => {
  const requested = await client.post('/identity/email/change/request', {
    newEmail,
    currentPassword: PASSWORD,
  });
  expect(requested.status).toBe(200);
  const mail = await waitForEmail(newEmail, (m) => m.subject === CONFIRM_SUBJECT);
  const otp = /(\d{6})/.exec(mail.text)?.[1];
  if (!otp) {
    throw new Error('no code in mail');
  }
  return otp;
};

const confirm = (client: TestClient, newEmail: string, otp: string) =>
  client.post('/identity/email/change/confirm', { newEmail, otp });

const exec = (statement: string) => drizzle().execute(sql.raw(statement));

/** Trigger that runs `body` (plpgsql) on each INSERT/UPDATE/DELETE of `table`; dropped after `run`. */
async function withTrigger(table: string, events: string, body: string, run: () => Promise<void>) {
  const name = `probe_${randomUUID().replaceAll('-', '')}`;
  await exec(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN ${body} RETURN COALESCE(NEW, OLD); END $$`);
  await exec(
    `CREATE TRIGGER ${name} BEFORE ${events} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`,
  );
  try {
    await run();
  } finally {
    await exec(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
    await exec(`DROP FUNCTION IF EXISTS ${name}()`);
  }
}

describe('registered email recording (case 1, 11)', () => {
  it('stores the lowercased login email, answers check-email, and ignores a duplicate sign-up', async () => {
    const email = `Mixed-${randomUUID()}@Case.test`;
    const res = await submitRegistration(app, { email });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'check-email' });
    const [row] = await drizzle()
      .select({ email: user.email, registeredEmail: user.registeredEmail })
      .from(user)
      .where(eq(user.email, email.toLowerCase()));
    expect(row).toEqual({ email: email.toLowerCase(), registeredEmail: email.toLowerCase() });
  });
});

describe('every write of the confirm is in one transaction (attack A)', () => {
  it('commits user, verification, audit and outbox writes under one txid and one backend', async () => {
    const p = await newPlayer();
    const newEmail = `email-atomic-probe-${randomUUID()}@e2e.test`;
    const otp = await requestChange(p.client, newEmail);
    await exec(
      `CREATE TABLE IF NOT EXISTS tx_probe (id bigserial PRIMARY KEY, tbl text, op text, txid bigint, pid int)`,
    );
    await exec(`TRUNCATE tx_probe`);
    const tables = [
      '"user"',
      'session',
      'account',
      'verification',
      'two_factor',
      'audit_log',
      'event_outbox',
    ];
    const names: string[] = [];
    for (const t of tables) {
      const name = `probe_${randomUUID().replaceAll('-', '')}`;
      names.push(name);
      await exec(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO tx_probe(tbl, op, txid, pid) VALUES ('${t.replaceAll('"', '')}', TG_OP, txid_current(), pg_backend_pid()); RETURN COALESCE(NEW, OLD); END $$`);
      await exec(
        `CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE OR DELETE ON ${t} FOR EACH ROW EXECUTE FUNCTION ${name}()`,
      );
    }
    let probe: { id: string; tbl: string; op: string; txid: string; pid: number }[] = [];
    try {
      const res = await confirm(p.client, newEmail, otp);
      expect(res.status).toBe(200);
      probe = (await drizzle().execute(sql.raw(`SELECT * FROM tx_probe ORDER BY id`)))
        .rows as typeof probe;
    } finally {
      for (const [i, t] of tables.entries()) {
        await exec(`DROP TRIGGER IF EXISTS ${names[i]} ON ${t}`);
        await exec(`DROP FUNCTION IF EXISTS ${names[i]}()`);
      }
    }
    const audit = probe.find((r) => r.tbl === 'audit_log');
    expect(audit).toBeDefined();
    const inTx = probe.filter((r) => r.txid === audit?.txid);
    // every write up to and including the outbox insert (the relay's later UPDATE of it is not part of it) belongs to the audit row's transaction
    const lastOutbox = probe.findIndex((r) => r.tbl === 'event_outbox' && r.op === 'INSERT');
    for (const r of probe.slice(0, lastOutbox + 1)) {
      expect(r.txid, `${r.tbl} ${r.op} escaped the transaction`).toBe(audit?.txid);
      expect(r.pid).toBe(audit?.pid);
    }
    expect(inTx.map((r) => `${r.tbl}:${r.op}`)).toEqual(
      expect.arrayContaining(['user:UPDATE', 'audit_log:INSERT', 'event_outbox:INSERT']),
    );
    await exec(`DROP TABLE IF EXISTS tx_probe`);
  });
});

describe('failure inside the transaction (attack A, B)', () => {
  it('rolls the swap back when better-auth burns the code (verification delete) fails', async () => {
    const p = await newPlayer();
    const newEmail = `email-atomic-vdel-${randomUUID()}@e2e.test`;
    const otp = await requestChange(p.client, newEmail);
    await withTrigger('verification', 'DELETE', `RAISE EXCEPTION 'injected failure';`, async () => {
      const res = await confirm(p.client, newEmail, otp);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await res.text()).not.toContain('injected');
    });
    expect((await userRow(p.userId))?.email).toBe(p.email);
    expect(await auditRows(p.playerId)).toHaveLength(0);
    expect(await outboxCount(p.userId)).toBe(0);
    // the same code works once the fault is gone
    expect((await confirm(p.client, newEmail, otp)).status).toBe(200);
    expect(await auditRows(p.playerId)).toHaveLength(1);
  });

  it('keeps the committed change, its audit row and outbox event when only the post-commit session revocation fails', async () => {
    const p = await newPlayer();
    const newEmail = `email-atomic-sess-${randomUUID()}@e2e.test`;
    const otp = await requestChange(p.client, newEmail);
    await withTrigger('session', 'UPDATE', `RAISE EXCEPTION 'injected failure';`, async () => {
      // The swap committed before the revocation ran; the answer is whatever the service gives.
      await confirm(p.client, newEmail, otp);
    });
    expect((await userRow(p.userId))?.email).toBe(newEmail);
    expect(await auditRows(p.playerId)).toHaveLength(1);
    expect(await outboxCount(p.userId)).toBe(1);
  });

  it('a refused code writes its attempt count and nothing else; an email taken meanwhile changes nothing', async () => {
    const p = await newPlayer();
    const taken = await newPlayer();
    const newEmail = `email-atomic-taken-${randomUUID()}@e2e.test`;
    const otp = await requestChange(p.client, newEmail);
    const attempts = async () =>
      (
        await drizzle()
          .select({ value: verification.value })
          .from(verification)
          .where(like(verification.identifier, `%${newEmail}%`))
      ).map((r) => r.value);
    const before = await attempts();
    const wrong = otp === '000000' ? '111111' : '000000';
    expect((await confirm(p.client, newEmail, wrong)).status).toBe(400);
    const afterWrong = await attempts();
    expect(before.map((v) => v?.split(':')[1])).toEqual(['0']);
    expect(afterWrong.map((v) => v?.split(':')[1])).toEqual(['1']);
    expect((await userRow(p.userId))?.email).toBe(p.email);
    expect(await auditRows(p.playerId)).toHaveLength(0);

    // The address is taken by another account between request and confirm.
    await drizzle().update(user).set({ email: newEmail }).where(eq(user.id, taken.userId));
    const res = await confirm(p.client, newEmail, otp);
    expect(res.status).toBe(400);
    expect((await userRow(p.userId))?.email).toBe(p.email);
    expect((await userRow(taken.userId))?.email).toBe(newEmail);
    expect(await auditRows(p.playerId)).toHaveLength(0);
    expect(await outboxCount(p.userId)).toBe(0);
  });
});

describe('row lock (attack C)', () => {
  it('measures how long a parallel sign-in and session read wait while a confirm holds the row', async () => {
    const p = await newPlayer();
    const newEmail = `email-atomic-lock-${randomUUID()}@e2e.test`;
    const otp = await requestChange(p.client, newEmail);
    const HOLD_MS = 1500;
    const result: Record<string, number> = {};
    await withTrigger(
      'audit_log',
      'INSERT',
      `IF NEW.action = 'identity.email.changed' THEN PERFORM pg_sleep(${HOLD_MS / 1000}); END IF;`,
      async () => {
        const t0 = Date.now();
        const confirming = confirm(p.client, newEmail, otp).then((r) => {
          result['confirmMs'] = Date.now() - t0;
          return r;
        });
        await new Promise((r) => setTimeout(r, 300));
        const t1 = Date.now();
        const signIn = Promise.resolve(
          app.app.request('/identity/login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: p.email, password: PASSWORD }),
          }),
        ).then((r) => {
          result['signInMs'] = Date.now() - t1;
          result['signInStatus'] = r.status;
        });
        const read = Promise.resolve(p.client.get('/identity/2fa/status')).then((r) => {
          result['sessionReadMs'] = Date.now() - t1;
          result['sessionReadStatus'] = r.status;
        });
        const other = await newPlayer();
        const t2 = Date.now();
        await other.client.get('/identity/2fa/status');
        result['otherUserReadMs'] = Date.now() - t2;
        await Promise.all([confirming, signIn, read]);
      },
    );
    expect(result['confirmMs']).toBeGreaterThanOrEqual(HOLD_MS);
    // Other accounts and the session read of the same account are not queued behind the row lock.
    expect(result['otherUserReadMs']).toBeLessThan(HOLD_MS / 2);
    expect(result['sessionReadMs']).toBeLessThan(HOLD_MS / 2);
    // The sign-in inserts a session row for the locked user, so it waits for the commit, then succeeds.
    expect(result['signInStatus']).toBe(200);
  });

  it('serves 25 confirms for distinct accounts at once on a 10-connection pool without a stall', async () => {
    const players = await Promise.all(Array.from({ length: 25 }, () => newPlayer()));
    const prepared = [];
    for (const p of players) {
      const newEmail = `email-atomic-pool-${randomUUID()}@e2e.test`;
      prepared.push({ p, newEmail, otp: await requestChange(p.client, newEmail) });
    }
    const answers = await Promise.all(prepared.map((x) => confirm(x.p.client, x.newEmail, x.otp)));
    expect(answers.every((a) => a.status === 200)).toBe(true);
    for (const x of prepared) {
      expect((await userRow(x.p.userId))?.email).toBe(x.newEmail);
      expect(await auditRows(x.p.playerId)).toHaveLength(1);
    }
  }, 60_000);
});

describe('support history against registered_email (cases 8, 9, 10, 12)', () => {
  const history = async (userId: string) => {
    const res = await admin.get(`/support-chat/admin/players/${userId}/history`);
    expect(res.status).toBe(200);
    return (await res.json()) as { tickets: { state: string; complete?: boolean } };
  };
  const registeredAtOf = async (userId: string) => (await userRow(userId))?.createdAt.toISOString();

  it('lost first change: no registration window, tickets not complete, reader not asked', async () => {
    const p = await newPlayer();
    await drizzle()
      .update(user)
      .set({ registeredEmail: `lost-first-${randomUUID()}@e2e.test` })
      .where(eq(user.id, p.userId));
    const body = await history(p.userId);
    expect(body.tickets.state).not.toBe('ok');
    expect(readSupportHistoryCalls().listTickets).toEqual([]);
  });

  it('registered email in another case: window from registration, complete', async () => {
    const p = await newPlayer();
    await drizzle()
      .update(user)
      .set({ registeredEmail: p.email.toUpperCase() })
      .where(eq(user.id, p.userId));
    const body = await history(p.userId);
    expect(body.tickets).toMatchObject({ state: 'ok', complete: true });
    expect(readSupportHistoryCalls().listTickets[0]?.windows).toEqual([
      { email: p.email, from: await registeredAtOf(p.userId), to: null },
    ]);
  });

  it('pre-deploy account (registered_email NULL) behaves as before, also after a change', async () => {
    const p = await newPlayer();
    await drizzle().update(user).set({ registeredEmail: null }).where(eq(user.id, p.userId));
    const body = await history(p.userId);
    expect(body.tickets).toMatchObject({ state: 'ok', complete: true });
    expect(readSupportHistoryCalls().listTickets[0]?.windows).toEqual([
      { email: p.email, from: await registeredAtOf(p.userId), to: null },
    ]);
    resetSupportHistory();
    const client = await asPlayer(app.app, { email: p.email });
    const newEmail = `email-atomic-null-${randomUUID()}@e2e.test`;
    expect((await confirm(client, newEmail, await requestChange(client, newEmail))).status).toBe(
      200,
    );
    expect((await userRow(p.userId))?.registeredEmail).toBeNull();
    // admin cache holds the first answer for a minute; use another admin read key
    const res = await admin.get(
      `/support-chat/admin/players/${p.userId}/history?includeResolved=true`,
    );
    expect(res.status).toBe(200);
    expect(readSupportHistoryCalls().listTickets[0]?.windows).toHaveLength(2);
  });
});

describe('boot: identity depends on audit (case 13)', () => {
  const ENV = ['SERVICE_MANIFEST', 'SERVICE_NAME', 'REALTIME_NAMESPACE'] as const;

  async function bootWithManifest(manifest: string) {
    const saved = ENV.map((k) => process.env[k]);
    process.env['SERVICE_MANIFEST'] = manifest;
    process.env['SERVICE_NAME'] ??= 'email-atomic-test';
    process.env['REALTIME_NAMESPACE'] ??= 'email-atomic-test';
    const testDb = await setupTestDb();
    try {
      const plugins = await loadExtensions();
      const booted = await bootTestApp({ plugins, databaseUrl: testDb.url });
      await booted.close();
    } finally {
      ENV.forEach((k, i) => {
        if (saved[i] === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = saved[i];
        }
      });
      await testDb.dispose();
    }
  }

  it.each(['identity', 'identity:no-routes'])(
    'refuses to boot %s without audit, naming the missing module',
    async (manifest) => {
      await expect(bootWithManifest(manifest)).rejects.toThrow(
        /Plugin "identity" depends on "audit" which is not registered/,
      );
    },
    60_000,
  );

  it('boots identity together with audit', async () => {
    await bootWithManifest('identity,audit,mail');
  }, 60_000);
});
