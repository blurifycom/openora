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
import { MAIL_SEND_QUEUE, type MailSendJob } from '../contract/index.js';

const logger = createLogger('mail');

const DEFAULT_LOCALE = 'en';

// A permanent send failure for one of these keys is a regulatory event the
// operator must be able to evidence (MGA/UKGC: the player must be told). Every
// other key's failure is operational only - logged, not audited (B9 / ADR-0036).
const REGULATORY_KEYS = new Set<MailTemplate['key']>([
  'rgLimitUpdated',
  'rgCoolingOffActivated',
  'rgCoolingOffLifted',
  'rgSelfExclusionActivated',
  'rgSelfExclusionLifted',
  'kycResubmissionRequested',
]);

// Matches the notifications module's dispatch retry shape (#110): 5 tries, growing gap.
// These govern the SEND once the job is on the queue.
const MAIL_ENQUEUE_OPTS = {
  attempts: 5,
  backoff: { type: 'exponential', delayMs: 1000 },
} as const;

// Getting the job ONTO the queue is the fragile step (a brief queue-backend outage).
// A bare `.catch(log)` there loses the mail silently, so retry the enqueue a few
// times with a short gap before giving up. This is the interim guard for the ack
// gap (B11 / ADR-0036); the durable fix is an outbox row in the caller's txn.
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
};

/**
 * The one send path. `enqueue*` is called synchronously by `MAIL_DISPATCH`
 * consumers and only puts a job on the `mail-send` queue - never renders, never
 * calls the transport. `deliver` runs later in the queue worker: it resolves the
 * address and locale, renders once, and sends. `onDeliveryExhausted` is the
 * worker's dead-letter hook.
 */
export class MailService {
  private readonly sender: EmailSenderPort;
  private readonly renderer: EmailTemplateRenderer;
  private readonly directory: AdminUserDirectory;
  private readonly jobQueue: JobQueueAdapter;
  private readonly audit: AuditWritePort | null;

  constructor(deps: MailServiceDeps) {
    this.sender = deps.sender;
    this.renderer = deps.renderer;
    this.directory = deps.directory;
    this.jobQueue = deps.jobQueue;
    this.audit = deps.audit;
  }

  async enqueueToUser({ userId, template, idempotencyKey }: MailToUserInput): Promise<void> {
    await withEnqueueRetry(() =>
      this.jobQueue.enqueue(
        MAIL_SEND_QUEUE,
        { recipient: { kind: 'user', userId }, template } satisfies MailSendJob,
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
        {
          recipient: { kind: 'address', email, ...(locale ? { locale } : {}) },
          template,
        } satisfies MailSendJob,
        { idempotencyKey, ...MAIL_ENQUEUE_OPTS },
      ),
    );
  }

  // Throws only on a retryable failure (transport error). A missing address is
  // permanent - it is logged and swallowed so the queue does not spin on it.
  async deliver(job: MailSendJob): Promise<void> {
    const resolved = await this.resolveRecipient(job);
    if (!resolved) {
      return;
    }
    const rendered = await this.renderer.render(job.template, resolved.locale);
    await this.sender.send({
      to: resolved.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
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
        after: { templateKey: job.template.key, error: error.message },
      })
      .catch((err) => logger.error({ err }, 'mail regulatory-failure audit write failed'));
  }

  private async resolveRecipient(
    job: MailSendJob,
  ): Promise<{ email: string; locale: string } | null> {
    if (job.recipient.kind === 'address') {
      return { email: job.recipient.email, locale: job.recipient.locale ?? DEFAULT_LOCALE };
    }
    const row = await this.directory.get(job.recipient.userId);
    if (!row?.email) {
      logger.warn(
        { userId: job.recipient.userId, key: job.template.key },
        'mail skipped: no email for user',
      );
      return null;
    }
    return { email: row.email, locale: row.language ?? DEFAULT_LOCALE };
  }
}
