import { describe, it, expect, vi } from 'vitest';
import type {
  AdminUserDirectory,
  AuditWritePort,
  EmailSenderPort,
  EmailTemplateRenderer,
  JobQueueAdapter,
  MailTemplate,
} from '@openora/core/contracts';
import { mock } from '../../testing/mock.js';
import { MailService } from '../service/mail.service.js';
import { EncryptedMailSendJobSchema, MAIL_SEND_QUEUE } from '../contract/index.js';

const verify: MailTemplate = { key: 'verifyEmail', data: { otp: '123456' } };
const rgLifted: MailTemplate = { key: 'rgCoolingOffLifted', data: {} };
const withdrawal: MailTemplate = {
  key: 'withdrawalApproved',
  data: {
    amount: '10.00',
    currency: 'USDT',
    transactionId: '00000000-0000-0000-0000-000000000000',
    occurredAt: '2026-01-01T00:00:00.000Z',
  },
};

function build(
  over: {
    sender?: Partial<EmailSenderPort>;
    renderer?: Partial<EmailTemplateRenderer>;
    directory?: Partial<AdminUserDirectory>;
    jobQueue?: Partial<JobQueueAdapter>;
    audit?: AuditWritePort | null;
  } = {},
) {
  const sender = mock<EmailSenderPort>({ send: vi.fn(async () => undefined), ...over.sender });
  const renderer = mock<EmailTemplateRenderer>({
    render: vi.fn(() => ({ subject: 's', html: '<p>h</p>', text: 't' })),
    ...over.renderer,
  });
  const directory = mock<AdminUserDirectory>({
    get: vi.fn(async () => null),
    ...over.directory,
  });
  const jobQueue = mock<JobQueueAdapter>({
    enqueue: vi.fn(async () => ({ id: 'job-1' })),
    ...over.jobQueue,
  });
  const audit =
    over.audit === undefined
      ? mock<AuditWritePort>({ record: vi.fn(async () => undefined) })
      : over.audit;
  const svc = new MailService({
    sender,
    renderer,
    directory,
    jobQueue,
    audit,
    encryptionSecret: 'test-mail-encryption-secret-32chars',
  });
  return { svc, sender, renderer, directory, jobQueue, audit };
}

describe('MailService', () => {
  it('enqueues a job and never renders or sends on the caller thread', async () => {
    const { svc, jobQueue, sender, renderer } = build();

    await svc.enqueueToUser({ userId: 'u-1', template: verify, idempotencyKey: 'k-1' });

    expect(jobQueue.enqueue).toHaveBeenCalledWith(
      MAIL_SEND_QUEUE,
      expect.objectContaining({ ciphertext: expect.any(String) }),
      expect.objectContaining({ idempotencyKey: 'k-1', attempts: 5 }),
    );
    const payload = vi.mocked(jobQueue.enqueue).mock.calls[0]?.[1];
    expect(JSON.stringify(payload)).not.toContain('123456');
    expect(sender.send).not.toHaveBeenCalled();
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it('retries the enqueue on a transient queue failure', async () => {
    const enqueue = vi
      .fn()
      .mockRejectedValueOnce(new Error('queue down'))
      .mockResolvedValueOnce({ id: 'job-1' });
    const { svc } = build({ jobQueue: { enqueue } });

    await svc.enqueueToAddress({ email: 'a@b.com', template: verify, idempotencyKey: 'k-2' });

    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('decrypts a queued payload before rendering and delivery', async () => {
    const { svc, jobQueue, renderer, sender } = build();

    await svc.enqueueToAddress({
      email: 'de@b.com',
      locale: 'de',
      template: verify,
      idempotencyKey: 'k-3',
    });

    const encrypted = vi.mocked(jobQueue.enqueue).mock.calls[0]?.[1];
    if (!encrypted) {
      throw new Error('mail job was not queued');
    }
    await svc.deliverEncrypted(EncryptedMailSendJobSchema.parse(encrypted));

    expect(renderer.render).toHaveBeenCalledWith(verify, 'de', null);
    expect(sender.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'de@b.com' }));
  });

  it('delivers to an explicit address, rendering with the given locale and sending html + text', async () => {
    const { svc, renderer, sender } = build();

    await svc.deliver({
      recipient: { kind: 'address', email: 'de@b.com', locale: 'de' },
      template: verify,
    });

    expect(renderer.render).toHaveBeenCalledWith(verify, 'de', null);
    expect(sender.send).toHaveBeenCalledWith({
      to: 'de@b.com',
      subject: 's',
      html: '<p>h</p>',
      text: 't',
    });
  });

  it('resolves a user recipient to its address, account locale and display name', async () => {
    const { svc, renderer, sender } = build({
      directory: {
        get: vi.fn(async () => ({
          id: 'u-1',
          email: 'user@b.com',
          name: 'Ada',
          createdAt: new Date(),
          isActive: true,
          role: 'player',
          language: 'fr',
        })),
      },
    });

    await svc.deliver({ recipient: { kind: 'user', userId: 'u-1' }, template: verify });

    expect(renderer.render).toHaveBeenCalledWith(verify, 'fr', 'Ada');
    expect(sender.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'user@b.com' }));
  });

  it('passes a null name when the resolved user row has none', async () => {
    const { svc, renderer } = build({
      directory: {
        get: vi.fn(async () => ({
          id: 'u-1',
          email: 'user@b.com',
          name: null,
          createdAt: new Date(),
          isActive: true,
          role: 'player',
          language: 'fr',
        })),
      },
    });

    await svc.deliver({ recipient: { kind: 'user', userId: 'u-1' }, template: verify });

    expect(renderer.render).toHaveBeenCalledWith(verify, 'fr', null);
  });

  it('skips - without throwing - when the user has no address (nothing to retry)', async () => {
    const { svc, sender } = build({ directory: { get: vi.fn(async () => null) } });

    await expect(
      svc.deliver({ recipient: { kind: 'user', userId: 'ghost' }, template: verify }),
    ).resolves.toBeUndefined();
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('audits a delivered regulatory mail with its key, locale and attempt', async () => {
    const { svc, audit } = build({
      directory: {
        get: vi.fn(async () => ({
          id: 'u-1',
          email: 'user@b.com',
          name: null,
          createdAt: new Date(),
          isActive: true,
          role: 'player',
          language: 'de',
        })),
      },
    });

    await svc.deliver({ recipient: { kind: 'user', userId: 'u-1' }, template: rgLifted }, 2);

    expect((audit as AuditWritePort).record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'system',
        action: 'mail.regulatory_delivery.sent',
        resourceId: 'u-1',
        after: { templateKey: 'rgCoolingOffLifted', locale: 'de', attempt: 2 },
      }),
    );
  });

  it('does not audit a delivered non-regulatory mail', async () => {
    const { svc, audit } = build();

    await svc.deliver({ recipient: { kind: 'address', email: 'a@b.com' }, template: verify });

    expect((audit as AuditWritePort).record).not.toHaveBeenCalled();
  });

  it('audits an exhausted delivery for a regulatory key', async () => {
    const { svc, audit } = build({
      directory: {
        get: vi.fn(async () => ({
          id: 'u-1',
          email: 'user@b.com',
          name: null,
          createdAt: new Date(),
          isActive: true,
          role: 'player',
          language: 'de',
        })),
      },
    });

    await svc.onDeliveryExhausted(
      { recipient: { kind: 'user', userId: 'u-1' }, template: rgLifted },
      new Error('smtp 550'),
      5,
    );

    expect((audit as AuditWritePort).record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'system',
        action: 'mail.regulatory_delivery.failed',
        resourceId: 'u-1',
        after: {
          templateKey: 'rgCoolingOffLifted',
          locale: 'de',
          reason: 'Error',
          attempt: 5,
        },
      }),
    );
  });

  it('does not audit an exhausted delivery for a non-regulatory key', async () => {
    const { svc, audit } = build();

    await svc.onDeliveryExhausted(
      { recipient: { kind: 'user', userId: 'u-1' }, template: withdrawal },
      new Error('smtp 550'),
    );

    expect((audit as AuditWritePort).record).not.toHaveBeenCalled();
  });
});
