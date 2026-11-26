import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { MAIL_DISPATCH } from '@openora/core/contracts';
import { auditLog } from '@openora/core/audit/schema';
import {
  bootE2e,
  capturedEmailsFor,
  closeE2e,
  flushAudit,
  newPlayer,
  registerPlayer,
  registrationRequestHeaders,
  verificationOtpFor,
  waitForEmail,
  type E2e,
} from '../index.js';
import { failSendsTo, sendAttemptsTo } from './support/test-failing-mail-sender-plugin.js';
import { uniqueEmail } from './support/identity.js';

let e2e: E2e;

beforeAll(async () => {
  e2e = await bootE2e({
    plugins: [
      ...(await loadExtensions()),
      {
        id: 'testing-failing-mail-sender',
        path: fileURLToPath(
          new URL('./support/test-failing-mail-sender-plugin.ts', import.meta.url),
        ),
      },
    ],
  });
}, 60_000);

afterAll(() => closeE2e(e2e));

const db = () => e2e.app.container.get(DRIZZLE).db;
const dispatch = () => e2e.app.container.get(MAIL_DISPATCH);

const verificationMails = (email: string) =>
  capturedEmailsFor(email).filter((mail) => /verify your email/i.test(mail.subject));

describe('transactional and promotional mail', () => {
  it('registering a player delivers a welcome mail to the registered address', async () => {
    const email = uniqueEmail('mail-welcome');

    await registerPlayer(e2e.app, { email });

    const welcome = await waitForEmail(email, (mail) => mail.subject === 'Welcome');
    expect(welcome.to.toLowerCase()).toBe(email);
    expect(welcome.text).toContain('Your email address is verified');
    expect(capturedEmailsFor(email).filter((mail) => mail.subject === 'Welcome')).toHaveLength(1);
  });

  it('requesting email verification delivers a mail carrying the verification code', async () => {
    const email = uniqueEmail('mail-verify');
    await registerPlayer(e2e.app, { email, verifyEmail: false });
    await verificationOtpFor(email);
    expect(verificationMails(email)).toHaveLength(1);

    const requested = await e2e.app.app.request('/identity/email/verify/send', {
      method: 'POST',
      headers: registrationRequestHeaders(),
      body: JSON.stringify({ email }),
    });
    expect(requested.status).toBe(200);

    await waitForEmail(email, () => verificationMails(email).length === 2);
    const [latest] = verificationMails(email);
    const otp = /\b(\d{6})\b/.exec(latest?.text ?? '')?.[1];
    expect(otp).toBeDefined();
    const verified = await e2e.app.app.request('/identity/email/verify', {
      method: 'POST',
      headers: registrationRequestHeaders(),
      body: JSON.stringify({ email, otp }),
    });
    expect(verified.status).toBe(200);
  });

  it('a verification code mail is delivered once for a repeated idempotency key', async () => {
    const email = uniqueEmail('mail-idem');
    const key = `e2e-verify:${randomUUID()}`;
    const template = { key: 'verifyEmail', data: { otp: '482916' } } as const;

    await dispatch().toAddress({ email, template, idempotencyKey: key });
    await dispatch().toAddress({ email, template, idempotencyKey: key });
    await waitForEmail(email, (mail) => mail.text.includes('482916'));
    await dispatch().toAddress({ email, template, idempotencyKey: key });
    await dispatch().toAddress({
      email,
      template: { key: 'verifyEmail', data: { otp: '735104' } },
      idempotencyKey: `e2e-verify:${randomUUID()}`,
    });
    await waitForEmail(email, (mail) => mail.text.includes('735104'));

    const delivered = capturedEmailsFor(email).map((mail) => mail.text);
    expect(delivered.filter((text) => text.includes('482916'))).toHaveLength(1);
    expect(delivered.filter((text) => text.includes('735104'))).toHaveLength(1);
  });

  it.todo(
    'GAP: a promotional mail is not sent to a player who opted out of marketing - core/src/contracts/schemas/mail.ts:27 MAIL_TEMPLATE_KEYS has no promotional template and no player marketing-consent exists; the welcome mail flag promotionsEligible (core/src/engagement/notifications/plugin.ts:770) reflects RG restriction and geo only',
  );

  it('a mail to a player without an email address is skipped without throwing', async () => {
    const unknownUserId = randomUUID();
    const sentinelEmail = uniqueEmail('mail-sentinel');

    await dispatch().toUser({
      userId: unknownUserId,
      template: { key: 'rgCoolingOffLifted', data: { initiatedBy: 'player' } },
      idempotencyKey: `e2e-no-email:${unknownUserId}`,
    });
    await dispatch().toAddress({
      email: sentinelEmail,
      template: { key: 'verifyEmail', data: { otp: '190283' } },
      idempotencyKey: `e2e-sentinel:${randomUUID()}`,
    });
    await waitForEmail(sentinelEmail, (mail) => mail.text.includes('190283'));

    await vi.waitFor(async () => {
      await flushAudit(e2e.app);
      const rows = await db()
        .select({ after: auditLog.after, actorType: auditLog.actorType })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, 'mail.regulatory_delivery.failed'),
            eq(auditLog.resourceId, unknownUserId),
          ),
        );
      expect(rows).toEqual([
        {
          actorType: 'system',
          after: { templateKey: 'rgCoolingOffLifted', reason: 'no_recipient_email', attempt: 1 },
        },
      ]);
    });
  });

  it('a failing sender retries and, once exhausted, records the failure without losing the job', async () => {
    const player = await newPlayer(e2e.app, 'mail-failing');
    failSendsTo(player.email);

    await dispatch().toUser({
      userId: player.userId,
      template: { key: 'rgCoolingOffLifted', data: { initiatedBy: 'player' } },
      idempotencyKey: `e2e-failing:${randomUUID()}`,
    });

    await expect
      .poll(
        async () => {
          await flushAudit(e2e.app);
          const rows = await db()
            .select({ after: auditLog.after })
            .from(auditLog)
            .where(
              and(
                eq(auditLog.action, 'mail.regulatory_delivery.failed'),
                eq(auditLog.resourceId, player.userId),
              ),
            );
          return rows.map((row) => row.after);
        },
        { timeout: 45_000, interval: 1_000 },
      )
      .toEqual([
        {
          templateKey: 'rgCoolingOffLifted',
          locale: 'en',
          reason: 'MailDeliveryRefusedError',
          attempt: 5,
        },
      ]);
    expect(sendAttemptsTo(player.email)).toBe(5);
    expect(capturedEmailsFor(player.email).some((mail) => /cooling/i.test(mail.subject))).toBe(
      false,
    );
  }, 90_000);
});
