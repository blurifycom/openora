export * from './financial.js';
export * from './funnel.js';
export * from './agent-tools.js';

import { financialContract } from './financial.js';
import { funnelContract } from './funnel.js';

export const analyticsContract = {
  financial: financialContract,
  funnel: funnelContract,
};
