// Internal barrel of the SocialTransfers module. The public consumer surface is the
// domain barrel (@openora/core/engagement), which re-exports this module's
// contract/ slice; cross-domain table reads go through @openora/core/engagement/schema/social-transfers.
export { SocialTransfersService } from './service/social-transfers.service.js';
export { createSocialTransfersRouter } from './router/index.js';
