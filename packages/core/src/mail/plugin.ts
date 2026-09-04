import {
  ADMIN_USER_DIRECTORY,
  AUDIT_WRITER,
  EMAIL_SENDER,
  EMAIL_TEMPLATE_RENDERER,
  JOB_QUEUE,
  MAIL_DISPATCH,
} from '@openora/core/contracts';
import { createLogger } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin, TypedContainer } from '@openora/core/server';
import { MailService } from './service/mail.service.js';
import { MIN_MAIL_ENCRYPTION_SECRET_LENGTH } from './service/mail-payload.service.js';
import { DefaultEmailTemplateRenderer } from './adapters/default-email-template-renderer.js';
import { StdoutEmailSender } from './adapters/stdout-email-sender.js';
import { EncryptedMailSendJobSchema, MAIL_SEND_QUEUE } from './contract/index.js';

const logger = createLogger('mail');

export default {
  id: 'mail',
  register(ctx) {
    const encryptionSecret = process.env['AUTH_SECRET'] ?? '';
    if (encryptionSecret.length < MIN_MAIL_ENCRYPTION_SECRET_LENGTH) {
      throw new Error(
        `mail: AUTH_SECRET must be at least ${MIN_MAIL_ENCRYPTION_SECRET_LENGTH} characters - mail-send job payloads (OTPs, invitation tokens) are encrypted with it`,
      );
    }

    let svcRef: MailService | null = null;
    const mailService = (c: TypedContainer<CoreTokenCatalog>): MailService =>
      (svcRef ??= new MailService({
        sender: c.get(EMAIL_SENDER),
        renderer: c.get(EMAIL_TEMPLATE_RENDERER),
        directory: c.get(ADMIN_USER_DIRECTORY),
        jobQueue: c.get(JOB_QUEUE),
        audit: c.has(AUDIT_WRITER) ? c.get(AUDIT_WRITER) : null,
        encryptionSecret,
      }));

    ctx.provide(EMAIL_SENDER, () => new StdoutEmailSender());
    ctx.provide(EMAIL_TEMPLATE_RENDERER, () => new DefaultEmailTemplateRenderer());

    ctx.provide(MAIL_DISPATCH, (c) => {
      const svc = mailService(c);
      return {
        toUser: (input) => svc.enqueueToUser(input),
        toAddress: (input) => svc.enqueueToAddress(input),
      };
    });

    ctx.routers.add('mail', (c) => {
      if (c.get(EMAIL_SENDER) instanceof StdoutEmailSender) {
        const msg =
          'mail: no EMAIL_SENDER overlay bound. StdoutEmailSender only logs metadata and never ' +
          'delivers - bind a real EMAIL_SENDER (SMTP/SES/Postmark) in an overlay loaded after the mail plugin.';
        if (process.env['NODE_ENV'] === 'production') {
          throw new Error(msg);
        }
        logger.warn(msg);
      }
      mailService(c);
      return {};
    });

    ctx.jobs.worker({
      queue: MAIL_SEND_QUEUE,
      schema: EncryptedMailSendJobSchema,
      options: { concurrency: 5 },
      handler: async ({ payload, attempt }) => {
        if (!svcRef) {
          throw new Error('mail: service not constructed yet');
        }
        await svcRef.deliverEncrypted(payload, attempt);
      },
      onDeadLetter: (jobCtx, error) => {
        if (!svcRef) {
          logger.error({ err: error }, 'mail delivery exhausted retries before service init');
          return;
        }
        return svcRef.onEncryptedDeliveryExhausted(jobCtx.payload, error, jobCtx.attempt);
      },
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;
