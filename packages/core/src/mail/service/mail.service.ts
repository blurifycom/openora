import { createLogger } from '@openora/core/server';
import type {
  AuditWritePort,
  EmailTemplateRenderer,
  EmailSenderPort,
  JobQueueAdapter,
  MailTemplate,
  MailToAddressInput,
  MailToUserInput,
  MailRecipientDirectory,
  PlayEligibilityPort,
} from '@openora/core/contracts';
import { MAIL_SEND_QUEUE, type EncryptedMailSendJob, type MailSendJob } from '../contract/index.js';
import { createMailPayloadCipher, type MailPayloadCipher } from './mail-payload.service.js';

const logger = createLogger('mail');

const DEFAULT_LOCALE = 'en';

const REGULATORY_KEYS = new Set<MailTemplate['key']>([
  'rgLimitUpdated',
  'rgCoolingOffActivated',
  'rgCoolingOffLifted',
  'rgSelfExclusionActivated',
  'rgSelfExclusionLifted',
  'kycResubmissionRequested',
]);

const MAIL_ENQUEUE_OPTS = {
  attempts: 5,
  backoff: { type: 'exponential', delayMs: 1000 },
} as const;

const ENQUEUE_RETRY_DELAYS_MS = [100, 300, 800];

async function withEnqueueRetry(enqueue: () => Promise<unknown>): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await enqueue();
      return;
    } catch (err) {
      if (attempt >= ENQUEUE_RETRY_DELAYS_MS.length) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, ENQUEUE_RETRY_DELAYS_MS[attempt]));
    }
  }
}

export type MailServiceDeps = {
  sender: EmailSenderPort;
  renderer: EmailTemplateRenderer;
  directory: MailRecipientDirectory;
  jobQueue: JobQueueAdapter;
  audit: AuditWritePort | null;
  encryptionSecret: string;
  playEligibility?: PlayEligibilityPort | null;
};

export class MailService {
  private readonly sender: EmailSenderPort;
  private readonly renderer: EmailTemplateRenderer;
  private readonly directory: MailRecipientDirectory;
  private readonly jobQueue: JobQueueAdapter;
  private readonly audit: AuditWritePort | null;
  private readonly playEligibility: PlayEligibilityPort | null;
  private readonly payloadCipher: MailPayloadCipher;

  constructor(deps: MailServiceDeps) {
    this.sender = deps.sender;
    this.renderer = deps.renderer;
    this.directory = deps.directory;
    this.jobQueue = deps.jobQueue;
    this.audit = deps.audit;
    this.playEligibility = deps.playEligibility ?? null;
    this.payloadCipher = createMailPayloadCipher(deps.encryptionSecret);
  }

  async enqueueToUser({ userId, template, idempotencyKey }: MailToUserInput): Promise<void> {
    await withEnqueueRetry(() =>
      this.jobQueue.enqueue(
        MAIL_SEND_QUEUE,
        this.encrypt({ recipient: { kind: 'user', userId }, template }),
        { idempotencyKey, ...MAIL_ENQUEUE_OPTS },
      ),
    );
  }

  async enqueueToAddress({
    email,
    locale,
    antiPhishingCode,
    recipientName,
    template,
    idempotencyKey,
  }: MailToAddressInput): Promise<void> {
    await withEnqueueRetry(() =>
      this.jobQueue.enqueue(
        MAIL_SEND_QUEUE,
        this.encrypt({
          recipient: {
            kind: 'address',
            email,
            ...(locale ? { locale } : {}),
            ...(antiPhishingCode !== undefined ? { antiPhishingCode } : {}),
            ...(recipientName !== undefined ? { recipientName } : {}),
          },
          template,
        }),
        { idempotencyKey, ...MAIL_ENQUEUE_OPTS },
      ),
    );
  }

  async deliver(job: MailSendJob, attempt = 1): Promise<void> {
    const resolved = await this.resolveRecipient(job);
    if (!resolved) {
      await this.recordRegulatoryOutcome('mail.regulatory_delivery.failed', job, {
        reason: 'no_recipient_email',
        attempt,
      });
      return;
    }
    const rendered = await this.renderer.render(
      await this.withCurrentEligibility(job),
      resolved.locale,
      resolved.name,
      resolved.antiPhishingCode,
    );
    await this.sender.send({
      to: resolved.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    await this.recordRegulatoryOutcome('mail.regulatory_delivery.sent', job, {
      locale: resolved.locale,
      attempt,
    });
  }

  // The eligibility a welcome mail was queued with can go stale while the job waits or
  // retries: a player who self-excludes in that window must not be shown the promotion.
  // Only ever narrows - a queued `false` stays `false`, and an unanswerable check reads false.
  private async withCurrentEligibility(job: MailSendJob): Promise<MailTemplate> {
    const { template, recipient } = job;
    if (template.key !== 'welcome' || template.data.promotionsEligible !== true) {
      return template;
    }
    const stillEligible =
      recipient.kind === 'user' &&
      this.playEligibility !== null &&
      !(await this.playEligibility.isRestricted(recipient.userId).catch((err: unknown) => {
        logger.error({ err }, 'welcome mail eligibility recheck failed');
        return true;
      }));
    return stillEligible ? template : { ...template, data: { promotionsEligible: false } };
  }

  async deliverEncrypted(job: EncryptedMailSendJob, attempt = 1): Promise<void> {
    await this.deliver(this.payloadCipher.decrypt(job), attempt);
  }

  async onDeliveryExhausted(job: MailSendJob, error: Error, attempt = 1): Promise<void> {
    logger.error(
      { err: error.name, key: job.template.key, recipient: job.recipient.kind },
      'mail delivery exhausted retries',
    );
    const locale = await this.resolveLocale(job);
    await this.recordRegulatoryOutcome('mail.regulatory_delivery.failed', job, {
      locale,
      reason: error.name,
      attempt,
    });
  }

  async onEncryptedDeliveryExhausted(
    job: EncryptedMailSendJob,
    error: Error,
    attempt = 1,
  ): Promise<void> {
    let decrypted: MailSendJob;
    try {
      decrypted = this.payloadCipher.decrypt(job);
    } catch (decryptErr) {
      logger.error(
        { err: (decryptErr as Error).name, queue: MAIL_SEND_QUEUE },
        'mail dead-letter payload could not be decrypted',
      );
      await this.audit
        ?.record({
          actorType: 'system',
          action: 'mail.regulatory_delivery.failed',
          resourceType: 'email',
          resourceId: null,
          after: { reason: 'payload_undecryptable', queue: MAIL_SEND_QUEUE, attempt },
        })
        .catch((err) => logger.error({ err }, 'mail regulatory audit write failed'));
      return;
    }
    await this.onDeliveryExhausted(decrypted, error, attempt);
  }

  // `after` carries no free text - error.name, not error.message: a provider bounce
  // routinely embeds the recipient address, and audit_log is append-only.
  private async recordRegulatoryOutcome(
    action: 'mail.regulatory_delivery.sent' | 'mail.regulatory_delivery.failed',
    job: MailSendJob,
    after: { locale?: string; reason?: string; attempt: number },
  ): Promise<void> {
    if (!this.audit || !REGULATORY_KEYS.has(job.template.key)) {
      return;
    }
    await this.audit
      .record({
        actorType: 'system',
        action,
        resourceType: 'email',
        resourceId: job.recipient.kind === 'user' ? job.recipient.userId : null,
        after: { templateKey: job.template.key, ...after },
      })
      .catch((err) => logger.error({ err }, 'mail regulatory audit write failed'));
  }

  private encrypt(job: MailSendJob): EncryptedMailSendJob {
    return this.payloadCipher.encrypt(job);
  }

  private async resolveLocale(job: MailSendJob): Promise<string> {
    if (job.recipient.kind === 'address') {
      return job.recipient.locale ?? DEFAULT_LOCALE;
    }
    const row = await this.directory.getMailRecipient(job.recipient.userId);
    return row?.language ?? DEFAULT_LOCALE;
  }

  private async resolveRecipient(job: MailSendJob): Promise<{
    email: string;
    locale: string;
    name: string | null;
    antiPhishingCode: string | null;
  } | null> {
    if (job.recipient.kind === 'address') {
      // Pre-account emails (admin invitation, brand-new signup verification) correctly
      return {
        email: job.recipient.email,
        locale: job.recipient.locale ?? DEFAULT_LOCALE,
        name: job.recipient.recipientName ?? null,
        antiPhishingCode: job.recipient.antiPhishingCode ?? null,
      };
    }
    const row = await this.directory.getMailRecipient(job.recipient.userId);
    if (!row?.email) {
      logger.warn(
        { userId: job.recipient.userId, key: job.template.key },
        'mail skipped: no email for user',
      );
      return null;
    }
    return {
      email: row.email,
      locale: row.language ?? DEFAULT_LOCALE,
      name: row.name,
      antiPhishingCode: row.antiPhishingCode,
    };
  }
}
