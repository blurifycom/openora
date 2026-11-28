import { createToken, type Token } from './token.js';

export type TwoFactorSetupPolicy = {
  isSetupRequired(userId: string): Promise<boolean>;
};

export const TWO_FACTOR_SETUP_POLICY: Token<TwoFactorSetupPolicy> =
  createToken('TWO_FACTOR_SETUP_POLICY');
