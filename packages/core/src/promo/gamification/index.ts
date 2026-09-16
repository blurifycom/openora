// Internal barrel of the Gamification module. The public consumer surface is the
// domain barrel (@openora/core/promo), which re-exports this module's
// contract/ slice; cross-domain table reads go through @openora/core/promo/schema/gamification.
export { GamificationService } from './service/gamification.service.js';
export { createGamificationRouter } from './router/index.js';
