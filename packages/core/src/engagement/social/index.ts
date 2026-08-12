// Internal barrel of the Social module. The public consumer surface is the
// domain barrel (@openora/core/engagement), which re-exports this module's
// contract/ slice; cross-domain table reads go through @openora/core/engagement/schema/social.
export { SocialService } from './service/social.service.js';
export { createSocialRouter } from './router/index.js';
