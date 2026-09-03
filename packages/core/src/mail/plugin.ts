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

/**
 * The `mail` module: a thin module (no table, no HTTP routes) that owns the
 * outbound mail seams and the `mail-send` queue worker.
 *
 * It declares NO `dependsOn`. `notifications` depends on `identity`, and `identity`
 * needs a send path - a mail binding in either would close a load-order cycle. The
 * mail plugin binds its ports here, and every consumer resolves `MAIL_DISPATCH`
 * lazily in its own router factory, which runs after all plugins register.
 *
 * The `mail-send` worker needs a `MailService`, which is built the first time
 * `MAIL_DISPATCH` is resolved. The BullMQ worker starts consuming the moment it is
 * registered (before router factories run), and in a `mail`-only split deployment
 * NO consumer resolves `MAIL_DISPATCH` at all - so this plugin registers an empty
 * router purely to force `mailService(c)` at boot, before the first job is picked
 * up. See ADR-0036.
 */
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

    // No HTTP surface - this factory exists only so the boot-time router loop
    // constructs the MailService the worker below needs, in every deployment shape.
    ctx.routers.add('mail', (c) => {
      mailService(c);
      return {};
    });

    ctx.jobs.worker({
      queue: MAIL_SEND_QUEUE,
      schema: EncryptedMailSendJobSchema,
      // Mail providers rate-limit; keep the fan-out modest.
      options: { concurrency: 5 },
      handler: async ({ payload }) => {
        if (!svcRef) {
          // A leftover job picked up in the sub-millisecond window before the router
          // loop runs: throw so BullMQ retries (its backoff outlasts that window).
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
