import { createToken, type Token } from './token.js';
import type { User } from '../schemas/identity.js';

/**
 * Compliance's reading of the exclusions in force right now. A self-exclusion binds while it is
 * active, even past its `expiresAt`, until it is lifted; a cooling-off binds while it is active
 * and its `expiresAt` is in the future, so it stops at expiry before the sweep marks it expired.
 * A transactional read holds active exclusion rows FOR SHARE until settlement commits,
 * serializing an exclusion lift with the payout it gates.
 */
export type RgExclusionReader = {
  getExclusionState(
    userId: User['id'],
    tx?: unknown,
  ): Promise<{ isSelfExcluded: boolean; isCoolingOff: boolean }>;
};

export const RG_EXCLUSION_READER: Token<RgExclusionReader> =
  createToken<RgExclusionReader>('RG_EXCLUSION_READER');
