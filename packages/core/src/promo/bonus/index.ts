// Internal barrel of the Bonus module. The public consumer surface is the
// domain barrel (@openora/core/promo), which re-exports this module's
// contract/ slice; cross-domain table reads go through @openora/core/promo/schema/bonus.
export { BonusService } from './service/bonus.service.js';
export { resolveContributionPercent, weightedStake } from './shared/wagering-weight.js';
export type { WagerWeightRow } from './shared/wagering-weight.js';
