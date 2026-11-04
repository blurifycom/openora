import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, like, sql } from 'drizzle-orm';
import { DRIZZLE, eventOutbox, processedEvents } from '@openora/core/server';
import { user } from '@openora/core/pam/schema/identity';
import { auditLog } from '@openora/core/audit/schema';
import {
  registerAndMaterializePlayer,
  capturedEmailsFor,
  waitForEmail,
  type TestClient,
  type TestDb,
  type TestApp,
  bootE2e,
  closeE2e,
} from '../index.js';

let db: TestDb;
let app: TestApp;

const PASSWORD = 'password1234';
const CONFIRM_SUBJECT = 'Confirm your new email address';
const CHANGED_SUBJECT = 'Your email address was changed';

const drizzle = () => app.container.get(DRIZZLE).db;

beforeAll(async () => {
  ({ db, app } = await bootE2e());
}, 60_000);

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

const emailOf = async (userId: string) => {
  const [row] = await drizzle().select({ email: user.email }).from(user).where(eq(user.id, userId));
  return row?.email;
};

const auditRows = (playerId: string) =>
  drizzle()
    .select({ id: auditLog.id, before: auditLog.before, after: auditLog.after })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, 'identity.email.changed'),
        eq(auditLog.resourceType, 'player'),
        eq(auditLog.resourceId, playerId),
      ),
    );

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

/** Asks for a change to `newEmail` and returns the code mailed to it. */
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

/**
 * Makes every insert into `table` that `when` matches raise, for the length of `run`. The trigger
 * lives in this file's own test database only and is dropped whatever `run` does.
 */
async function failingInsertsInto(table: string, when: string, run: () => Promise<void>) {
  const name = `fail_${table}_${randomUUID().replaceAll('-', '')}`;
  await drizzle().execute(
    sql.raw(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF ${when} THEN RAISE EXCEPTION 'injected failure'; END IF;
        RETURN NEW;
      END $$`),
  );
  await drizzle().execute(
    sql.raw(`CREATE TRIGGER ${name} BEFORE INSERT ON ${table}
      FOR EACH ROW EXECUTE FUNCTION ${name}()`),
  );
  try {
    await run();
  } finally {
    await drizzle().execute(sql.raw(`DROP TRIGGER IF EXISTS ${name} ON ${table}`));
    await drizzle().execute(sql.raw(`DROP FUNCTION IF EXISTS ${name}()`));
  }
}

describe('email change history', () => {
  it('commits the audit row and the outbox event with the swap, and the relay adds no second row', async () => {
    const p = await newPlayer();
    const newEmail = `email-history-new-${randomUUID()}@e2e.test`;
    const otp = await requestChange(p.client, newEmail);

    const confirmed = await confirm(p.client, newEmail, otp);

    expect(confirmed.status).toBe(200);
    // Read as the response returns, not waited for: the row is written with the change.
    const rows = await auditRows(p.playerId);
    expect(rows).toEqual([
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
    // The audit subscriber handles the relayed event and skips it.
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

  it.each([
    ['audit row', 'audit_log', `NEW.action = 'identity.email.changed'`],
    ['outbox event', 'event_outbox', `NEW.topic = 'identity.email.changed'`],
  ])(
    'saves nothing when the %s cannot be written, and the same code works once it can',
    async (_label, table, when) => {
      const p = await newPlayer();
      const newEmail = `email-history-fault-${randomUUID()}@e2e.test`;
      const otp = await requestChange(p.client, newEmail);

      await failingInsertsInto(table, when, async () => {
        const failed = await confirm(p.client, newEmail, otp);
        expect(failed.status).toBe(500);
        expect(await failed.text()).not.toContain('injected');
      });

      expect(await emailOf(p.userId)).toBe(p.email);
      expect(await auditRows(p.playerId)).toHaveLength(0);
      expect(await outboxRows(p.userId)).toHaveLength(0);
      // Sessions are revoked only after a committed change; this one still works.
      expect((await p.client.get('/identity/2fa/status')).status).toBe(200);

      const retried = await confirm(p.client, newEmail, otp);

      expect(retried.status).toBe(200);
      expect(await emailOf(p.userId)).toBe(newEmail);
      expect(await auditRows(p.playerId)).toHaveLength(1);
      expect(await outboxRows(p.userId)).toHaveLength(1);
      // The failed attempt sent no notice: the old inbox gets exactly the one for the retry.
      await waitForEmail(p.email, (m) => m.subject === CHANGED_SUBJECT);
      expect(capturedEmailsFor(p.email).filter((m) => m.subject === CHANGED_SUBJECT)).toHaveLength(
        1,
      );
    },
  );

  // Each refused guess commits its count: were it rolled back with the swap, the right code
  // would still be accepted here.
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

    const won = answers.findIndex((r) => r.status === 200);
    expect(answers.filter((r) => r.status === 200)).toHaveLength(1);
    const winner = won === 0 ? first : second;
    expect(await emailOf(p.userId)).toBe(winner);
    const rows = await auditRows(p.playerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.after).toMatchObject({ email: winner });
  });
});
