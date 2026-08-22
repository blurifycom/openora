import { createToken, type Token } from './token.js';

export type PlayerProvisioning = {
  /**
   * `created: false` means a player row already existed, so this consent record was
   * NOT stored. Callers must surface that - it is a compliance record, not a no-op.
   */
  createForRegistration(
    record: PlayerRegistrationRecord,
  ): Promise<{ created: boolean; playerId?: string }>;
};

export type PlayerRegistrationRecord = {
  userId: string;
  termsVersion: string;
  termsAcceptedAt: Date;
  ageAcceptedAt: Date;
  registrationIp: string | null;
  registrationUserAgent: string | null;
};

export const PLAYER_PROVISIONING: Token<PlayerProvisioning> = createToken('PLAYER_PROVISIONING');
