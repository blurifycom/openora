import { createToken, type Token } from './token.js';
import type { User } from '../schemas/identity.js';

export type RgExclusionReader = {
  getExclusionState(
    userId: User['id'],
    tx?: unknown,
  ): Promise<{ isSelfExcluded: boolean; isCoolingOff: boolean }>;
};

export const RG_EXCLUSION_READER: Token<RgExclusionReader> =
  createToken<RgExclusionReader>('RG_EXCLUSION_READER');
