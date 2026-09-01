export { MailService, type MailServiceDeps } from './service/mail.service.js';
export { DefaultEmailTemplateRenderer } from './adapters/default-email-template-renderer.js';
export { StdoutEmailSender } from './adapters/stdout-email-sender.js';
export {
  MAIL_SEND_QUEUE,
  MailSendJobSchema,
  MailRecipientSchema,
  type MailSendJob,
  type MailRecipient,
} from './contract/index.js';
