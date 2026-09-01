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
import { DefaultEmailTemplateRenderer } from './adapters/default-email-template-renderer.js';
import { StdoutEmailSender } from './adapters/stdout-email-sender.js';
import { EncryptedMailSendJobSchema, MAIL_SEND_QUEUE } from './contract/index.js';

const logger = createLogger('mail');

/**
 * The `mail` module: a thin module (no table, no routes) that owns the outbound
 * mail seams and the `mail-send` queue worker.
 *
 * It declares NO `dependsOn`. `notifications` depends on `identity`, and `identity`
 * needs a send path - a mail binding in either would close a load-order cycle. The
 * mail plugin binds its ports here, and every consumer resolves `MAIL_DISPATCH`
 * lazily in its own router/worker factory, which runs after all plugins register.
 * `svcRef` is set the first time `MAIL_DISPATCH` is resolved (a consumer's boot-time
 * router factory), always before the first `mail-send` job runs. See ADR-0036.
 */
export default {
  id: 'mail',
  register(ctx) {
    let svcRef: MailService | null = null;
    const mailService = (c: TypedContainer<CoreTokenCatalog>): MailService =>
      (svcRef ??= new MailService({
        sender: c.get(EMAIL_SENDER),
        renderer: c.get(EMAIL_TEMPLATE_RENDERER),
        directory: c.get(ADMIN_USER_DIRECTORY),
        jobQueue: c.get(JOB_QUEUE),
        audit: c.has(AUDIT_WRITER) ? c.get(AUDIT_WRITER) : null,
        encryptionSecret: process.env['AUTH_SECRET'] ?? '',
      }));

    // Platform defaults: log-to-stdout transport, English-only plain-text renderer.
    ctx.provide(EMAIL_SENDER, () => new StdoutEmailSender());
    ctx.provide(EMAIL_TEMPLATE_RENDERER, () => new DefaultEmailTemplateRenderer());

    ctx.provide(MAIL_DISPATCH, (c) => {
      const svc = mailService(c);
      return {
        toUser: (input) => svc.enqueueToUser(input),
        toAddress: (input) => svc.enqueueToAddress(input),
      };
    });

    ctx.jobs.worker({
      queue: MAIL_SEND_QUEUE,
      schema: EncryptedMailSendJobSchema,
      // Mail providers rate-limit; keep the fan-out modest.
      options: { concurrency: 5 },
      handler: async ({ payload }) => {
        if (!svcRef) {
          throw new Error('mail: service not constructed yet');
        }
        await svcRef.deliverEncrypted(payload);
      },
      onDeadLetter: (jobCtx, error) => {
        if (!svcRef) {
          logger.error({ err: error }, 'mail delivery exhausted retries before service init');
          return;
        }
        return svcRef.onEncryptedDeliveryExhausted(jobCtx.payload, error);
      },
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;
