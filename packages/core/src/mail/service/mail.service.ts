import { createLogger } from '@openora/core/server';
import type {
  AdminUserDirectory,
  AuditWritePort,
  EmailTemplateRenderer,
  EmailSenderPort,
  JobQueueAdapter,
  MailTemplate,
  MailToAddressInput,
  MailToUserInput,
} from '@openora/core/contracts';
import { MAIL_SEND_QUEUE, type EncryptedMailSendJob, type MailSendJob } from '../contract/index.js';
import { createMailPayloadCipher, type MailPayloadCipher } from './mail-payload.service.js';

const logger = createLogger('mail');

const DEFAULT_LOCALE = 'en';

// A permanent send failure for one of these keys is a regulatory event the operator
// must be able to evidence (MGA/UKGC: the player must be told). See ADR-0036.
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
  directory: AdminUserDirectory;
  jobQueue: JobQueueAdapter;
  audit: AuditWritePort | null;
  encryptionSecret: string;
};

/**
 * The one send path. `enqueue*` only puts an encrypted job on the `mail-send`
 * queue; `deliver` runs later in the worker (resolve recipient, render, send);
 * `onDeliveryExhausted` is the worker's dead-letter hook.
 */
export class MailService {
  private readonly sender: EmailSenderPort;
  private readonly renderer: EmailTemplateRenderer;
  private readonly directory: AdminUserDirectory;
  private readonly jobQueue: JobQueueAdapter;
  private readonly audit: AuditWritePort | null;
  private readonly payloadCipher: MailPayloadCipher;

  constructor(deps: MailServiceDeps) {
    this.sender = deps.sender;
    this.renderer = deps.renderer;
    this.directory = deps.directory;
    this.jobQueue = deps.jobQueue;
    this.audit = deps.audit;
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
    template,
    idempotencyKey,
  }: MailToAddressInput): Promise<void> {
    await withEnqueueRetry(() =>
      this.jobQueue.enqueue(
        MAIL_SEND_QUEUE,
        this.encrypt({
          recipient: { kind: 'address', email, ...(locale ? { locale } : {}) },
          template,
        }),
        { idempotencyKey, ...MAIL_ENQUEUE_OPTS },
      ),
    );
  }

  async deliver(job: MailSendJob): Promise<void> {
    const resolved = await this.resolveRecipient(job);
    if (!resolved) {
      return;
    }
    const rendered = await this.renderer.render(job.template, resolved.locale, resolved.name);
    await this.sender.send({
      to: resolved.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
  }

  async deliverEncrypted(job: EncryptedMailSendJob): Promise<void> {
    await this.deliver(this.payloadCipher.decrypt(job));
  }

  async onDeliveryExhausted(job: MailSendJob, error: Error): Promise<void> {
    logger.error(
      { err: error, key: job.template.key, recipient: job.recipient.kind },
      'mail delivery exhausted retries',
    );
    if (!this.audit || !REGULATORY_KEYS.has(job.template.key)) {
      return;
    }
    await this.audit
      .record({
        actorType: 'system',
        action: 'mail.regulatory_delivery.failed',
        resourceType: 'email',
        resourceId: job.recipient.kind === 'user' ? job.recipient.userId : null,
        // error.name only - a provider bounce message routinely embeds the recipient
        // address, and audit_log is append-only.
        after: { templateKey: job.template.key, reason: error.name },
      })
      .catch((err) => logger.error({ err }, 'mail regulatory-failure audit write failed'));
  }

  async onEncryptedDeliveryExhausted(job: EncryptedMailSendJob, error: Error): Promise<void> {
    await this.onDeliveryExhausted(this.payloadCipher.decrypt(job), error);
  }

  private encrypt(job: MailSendJob): EncryptedMailSendJob {
    return this.payloadCipher.encrypt(job);
  }

  private async resolveRecipient(
    job: MailSendJob,
  ): Promise<{ email: string; locale: string; name: string | null } | null> {
    if (job.recipient.kind === 'address') {
      return {
        email: job.recipient.email,
        locale: job.recipient.locale ?? DEFAULT_LOCALE,
        name: null,
      };
    }
    const row = await this.directory.get(job.recipient.userId);
    if (!row?.email) {
      logger.warn(
        { userId: job.recipient.userId, key: job.template.key },
        'mail skipped: no email for user',
      );
      return null;
    }
    return { email: row.email, locale: row.language ?? DEFAULT_LOCALE, name: row.name ?? null };
  }
}
