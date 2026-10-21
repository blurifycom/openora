// Internal barrel of the SupportChat module. The public consumer surface is the
// domain barrel (@openora/core/engagement), which re-exports this module's
// contract/ slice; cross-domain table reads go through @openora/core/engagement/schema/support-chat.
export { SupportChatService } from './service/support-chat.service.js';
export { createSupportChatRouter } from './router/index.js';
