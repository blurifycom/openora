export * from './financial.js';
export * from './funnel.js';

import { financialContract } from './financial.js';
import { funnelContract } from './funnel.js';

export const analyticsContract = {
  financial: financialContract,
  funnel: funnelContract,
};
