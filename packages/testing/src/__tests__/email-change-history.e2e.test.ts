import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq, like, sql } from 'drizzle-orm';
import { DRIZZLE, eventOutbox, loadExtensions, processedEvents } from '@openora/core/server';
import { user } from '@openora/core/pam/schema/identity';
import { auditLog } from '@openora/core/audit/schema';
import {
  asAdmin,
  registerAndMaterializePlayer,
  capturedEmailsFor,
  waitForEmail,
  type TestClient,
  type TestDb,
  type TestApp,
  bootE2e,
  closeE2e,
  flushAudit,
} from '../index.js';
import { readSupportHistoryCalls, resetSupportHistory } from '../test-support-history-plugin.js';

const historyPluginPath = fileURLToPath(
  new URL('../test-support-history-plugin.ts', import.meta.url),
);

let db: TestDb;
let app: TestApp;
let admin: TestClient;

const PASSWORD = 'password1234';
const CONFIRM_SUBJECT = 'Confirm your new email address';
const CHANGED_SUBJECT = 'Your email address was changed';
const AUTH_TABLES = ['"user"', 'session', 'account', 'verification', 'two_factor'];

const drizzle = () => app.container.get(DRIZZLE).db;
const exec = (statement: string) => drizzle().execute(sql.raw(statement));

beforeAll(async () => {
  ({ db, app } = await bootE2e({
    plugins: [
      ...(await loadExtensions()),
      { id: 'testing-support-history', path: historyPluginPath },
    ],
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
  const email = `email-history-${randomUUID()}@e2e.test`;
  const { client, userId, playerId } = await registerAndMaterializePlayer(app, {
    email,
    password: PASSWORD,
  });
  return { email, client, userId, playerId };
};

const userRow = async (userId: string) => {
  const [row] = await drizzle()
    .select({ email: user.email, registeredEmail: user.registeredEmail })
    .from(user)
    .where(eq(user.id, userId));
  return row;
};

const emailOf = async (userId: string) => (await userRow(userId))?.email;

const auditRows = async (playerId: string) => {
  await flushAudit(app);
  return drizzle()
    .select({ id: auditLog.id, before: auditLog.before, after: auditLog.after })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, 'identity.email.changed'),
        eq(auditLog.resourceType, 'player'),
        eq(auditLog.resourceId, playerId),
      ),
    );
};

const outboxRows = (userId: string) =>
  drizzle()
    .select({ eventId: eventOutbox.eventId, payload: eventOutbox.payload })
    .from(eventOutbox)
    .where(
      and(
        eq(eventOutbox.topic, 'identity.email.changed'),
        sql`${eventOutbox.payload}->>'userId' = ${userId}`,
      ),
    );

const requestChange = async (client: TestClient, newEmail: string) => {
  const requested = await client.post('/identity/email/change/request', {
    newEmail,
    currentPassword: PASSWORD,
  });
  expect(requested.status).toBe(200);
  const mail = await waitForEmail(newEmail, (m) => m.subject === CONFIRM_SUBJECT);
  const otp = /(\d{6})/.exec(mail.text)?.[1];
  if (!otp) {
    throw new Error(`no 6-digit code in the confirmation mail: ${mail.text}`);
  }
  return otp;
};

const confirm = (client: TestClient, newEmail: string, otp: string) =>
  client.post('/identity/email/change/confirm', { newEmail, otp });

async function withTriggers(
  tables: readonly string[],
  { events, body }: { events: string; body: string },
  run: () => Promise<void>,
) {
  const name = `probe_${randomUUID().replaceAll('-', '')}`;
  await exec(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN ${body} RETURN COALESCE(NEW, OLD); END $$`);
  try {
    for (const table of tables) {
      await exec(
        `CREATE TRIGGER ${name} BEFORE ${events} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`,
      );
    }
    await run();
  } finally {
    for (const table of tables) {
      await exec(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
    }
    await exec(`DROP FUNCTION IF EXISTS ${name}()`);
  }
}

const failing = (when: string) => ({
  events: 'INSERT',
  body: `IF ${when} THEN RAISE EXCEPTION 'injected failure'; END IF;`,
});

describe('email change history', () => {
  it('commits the audit row and the outbox event with the swap, and the relay adds no second row', async () => {
    const p = await newPlayer();
    const newEmail = `email-history-new-${randomUUID()}@e2e.test`;
    const otp = await requestChange(p.client, newEmail);

    const confirmed = await confirm(p.client, newEmail, otp);

    expect(confirmed.status).toBe(200);
    expect(await auditRows(p.playerId)).toEqual([
      {
        id: expect.any(String),
        before: { email: p.email },
        after: { email: newEmail, changedAt: expect.any(String) },
      },
    ]);
    const events = await outboxRows(p.userId);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      previousEmail: p.email,
      newEmail,
      auditRecorded: true,
    });
    const eventId = events[0]!.eventId;
    await vi.waitFor(
      async () => {
        const handled = await drizzle()
          .select({ consumer: processedEvents.consumer })
          .from(processedEvents)
          .where(
            and(
              eq(processedEvents.eventId, eventId),
              like(processedEvents.consumer, 'audit/identity.email.changed%'),
            ),
          );
        expect(handled).toHaveLength(1);
      },
      { timeout: 20_000 },
    );
    expect(await auditRows(p.playerId)).toHaveLength(1);
  });

  it('writes every row of the change in the one transaction that appends its audit row', async () => {
    const p = await newPlayer();
    const newEmail = `email-history-txid-${randomUUID()}@e2e.test`;
    const otp = await requestChange(p.client, newEmail);
    await exec(
      `CREATE TABLE IF NOT EXISTS tx_probe (id bigserial PRIMARY KEY, tbl text, op text, txid bigint, pid int)`,
    );
    await exec(`TRUNCATE tx_probe`);
    // Ship what the request queued now, so the shipper deletes no audit_outbox row inside the probe.
    await flushAudit(app);
    let probe: { tbl: string; op: string; txid: string; pid: number }[] = [];

    await withTriggers(
      [...AUTH_TABLES, 'audit_outbox', 'event_outbox'],
      {
        events: 'INSERT OR UPDATE OR DELETE',
        body: `INSERT INTO tx_probe(tbl, op, txid, pid) VALUES (TG_TABLE_NAME, TG_OP, txid_current(), pg_backend_pid());`,
      },
      async () => {
        expect((await confirm(p.client, newEmail, otp)).status).toBe(200);
        probe = (await exec(`SELECT tbl, op, txid, pid FROM tx_probe ORDER BY id`))
          .rows as typeof probe;
      },
    );

    const audit = probe.find((r) => r.tbl === 'audit_outbox' && r.op === 'INSERT');
    const outboxInsert = probe.findIndex((r) => r.tbl === 'event_outbox' && r.op === 'INSERT');
    expect(audit).toBeDefined();
    for (const r of probe.slice(0, outboxInsert + 1)) {
      expect({ write: `${r.tbl}:${r.op}`, txid: r.txid, pid: r.pid }).toEqual({
        write: `${r.tbl}:${r.op}`,
        txid: audit?.txid,
        pid: audit?.pid,
      });
    }
    expect(probe.slice(0, outboxInsert + 1).map((r) => `${r.tbl}:${r.op}`)).toEqual(
      expect.arrayContaining(['user:UPDATE', 'audit_outbox:INSERT', 'event_outbox:INSERT']),
    );
  });

  it.each([
    ['audit row', 'audit_outbox', `NEW.entry->>'action' = 'identity.email.changed'`],
    ['outbox event', 'event_outbox', `NEW.topic = 'identity.email.changed'`],
  ])(
    'saves nothing when the %s cannot be written, and the same code works once it can',
    async (_label, table, when) => {
      const p = await newPlayer();
      const newEmail = `email-history-fault-${randomUUID()}@e2e.test`;
      const otp = await requestChange(p.client, newEmail);

      await withTriggers([table], failing(when), async () => {
        const failed = await confirm(p.client, newEmail, otp);
        expect(failed.status).toBe(500);
        expect(await failed.text()).not.toContain('injected');
      });

      expect(await emailOf(p.userId)).toBe(p.email);
      expect(await auditRows(p.playerId)).toHaveLength(0);
      expect(await outboxRows(p.userId)).toHaveLength(0);
      expect((await p.client.get('/identity/2fa/status')).status).toBe(200);

      const retried = await confirm(p.client, newEmail, otp);

      expect(retried.status).toBe(200);
      expect(await emailOf(p.userId)).toBe(newEmail);
      expect(await auditRows(p.playerId)).toHaveLength(1);
      expect(await outboxRows(p.userId)).toHaveLength(1);
      await waitForEmail(p.email, (m) => m.subject === CHANGED_SUBJECT);
      expect(capturedEmailsFor(p.email).filter((m) => m.subject === CHANGED_SUBJECT)).toHaveLength(
        1,
      );
    },
  );

  it('keeps the committed change, its audit row and outbox event when the session revocation after it fails', async () => {
    const p = await newPlayer();
    const newEmail = `email-history-revoke-${randomUUID()}@e2e.test`;
    const otp = await requestChange(p.client, newEmail);

    await withTriggers(['session'], { ...failing('true'), events: 'UPDATE' }, async () => {
      await confirm(p.client, newEmail, otp);
    });

    expect(await emailOf(p.userId)).toBe(newEmail);
    expect(await auditRows(p.playerId)).toHaveLength(1);
    expect(await outboxRows(p.userId)).toHaveLength(1);
  });

  it('keeps the wrong-code count across attempts, so the right code is refused after three misses', async () => {
    const p = await newPlayer();
    const newEmail = `email-history-guess-${randomUUID()}@e2e.test`;
    const otp = await requestChange(p.client, newEmail);
    const wrong = otp === '000000' ? '111111' : '000000';

    for (let i = 0; i < 3; i++) {
      expect((await confirm(p.client, newEmail, wrong)).status).toBe(400);
    }
    const refused = await confirm(p.client, newEmail, otp);

    expect(refused.status).toBe(400);
    expect(await emailOf(p.userId)).toBe(p.email);
    expect(await auditRows(p.playerId)).toHaveLength(0);
  });

  it('changes nothing when another account took the new address between request and confirm', async () => {
    const p = await newPlayer();
    const taken = await newPlayer();
    const newEmail = `email-history-taken-${randomUUID()}@e2e.test`;
    const otp = await requestChange(p.client, newEmail);
    await drizzle().update(user).set({ email: newEmail }).where(eq(user.id, taken.userId));

    const res = await confirm(p.client, newEmail, otp);

    expect(res.status).toBe(400);
    expect(await emailOf(p.userId)).toBe(p.email);
    expect(await emailOf(taken.userId)).toBe(newEmail);
    expect(await auditRows(p.playerId)).toHaveLength(0);
    expect(await outboxRows(p.userId)).toHaveLength(0);
  });

  it('refuses a confirmation without a session', async () => {
    const res = await app.app.request('/identity/email/change/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        newEmail: `email-history-anon-${randomUUID()}@e2e.test`,
        otp: '123456',
      }),
    });

    expect(res.status).toBe(401);
  });

  it("refuses another account's code for the same new address and leaves the owner's code usable", async () => {
    const owner = await newPlayer();
    const other = await newPlayer();
    const newEmail = `email-history-steal-${randomUUID()}@e2e.test`;
    const otp = await requestChange(owner.client, newEmail);

    const stolen = await confirm(other.client, newEmail, otp);

    expect(stolen.status).toBe(400);
    expect(await emailOf(other.userId)).toBe(other.email);
    expect(await auditRows(other.playerId)).toHaveLength(0);
    expect((await confirm(owner.client, newEmail, otp)).status).toBe(200);
  });

  it('accepts one of two parallel submits of the same code and records one change', async () => {
    const p = await newPlayer();
    const newEmail = `email-history-twice-${randomUUID()}@e2e.test`;
    const otp = await requestChange(p.client, newEmail);

    const answers = await Promise.all([
      confirm(p.client, newEmail, otp),
      confirm(p.client, newEmail, otp),
    ]);

    expect(answers.map((r) => r.status).filter((s) => s === 200)).toHaveLength(1);
    expect(await emailOf(p.userId)).toBe(newEmail);
    expect(await auditRows(p.playerId)).toHaveLength(1);
    expect(await outboxRows(p.userId)).toHaveLength(1);
  });

  it('lets only one of two pending changes win when both are confirmed at once', async () => {
    const p = await newPlayer();
    const first = `email-history-first-${randomUUID()}@e2e.test`;
    const second = `email-history-second-${randomUUID()}@e2e.test`;
    const firstOtp = await requestChange(p.client, first);
    const secondOtp = await requestChange(p.client, second);

    const answers = await Promise.all([
      confirm(p.client, first, firstOtp),
      confirm(p.client, second, secondOtp),
    ]);

    expect(answers.filter((r) => r.status === 200)).toHaveLength(1);
    const winner = answers.findIndex((r) => r.status === 200) === 0 ? first : second;
    expect(await emailOf(p.userId)).toBe(winner);
    const rows = await auditRows(p.playerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.after).toMatchObject({ email: winner });
  });

  it('keeps the support history of an account without a registered email as before, also after a change', async () => {
    const p = await newPlayer();
    await drizzle().update(user).set({ registeredEmail: null }).where(eq(user.id, p.userId));
    const history = (query: string) =>
      admin.get(`/support-chat/admin/players/${p.userId}/history${query}`);

    expect((await history('')).status).toBe(200);
    expect(readSupportHistoryCalls().listTickets[0]?.windows).toEqual([
      { email: p.email, from: expect.any(String), to: null },
    ]);
    resetSupportHistory();
    const newEmail = `email-history-null-${randomUUID()}@e2e.test`;
    expect(
      (await confirm(p.client, newEmail, await requestChange(p.client, newEmail))).status,
    ).toBe(200);

    expect((await userRow(p.userId))?.registeredEmail).toBeNull();
    expect((await history('?includeResolved=true')).status).toBe(200);
    expect(readSupportHistoryCalls().listTickets[0]?.windows).toEqual([
      { email: p.email, from: expect.any(String), to: expect.any(String) },
      { email: newEmail, from: expect.any(String), to: null },
    ]);
  });
});
