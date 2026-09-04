import { createToken, type Token } from './token.js';

export type PlayerProvisioning = {
  /**
   * `created: false` means a player row already existed, so this consent record was
   * NOT stored. Callers must surface that - it is a compliance record, not a no-op.
   */
  createForRegistration(
    record: PlayerRegistrationRecord,
  ): Promise<{ created: boolean; playerId?: string }>;

  /**
   * Stores the IANA zone a browser reported. Display metadata - it never gates anything and
   * never reaches an RG window or an audit record. Best-effort by contract: an unrecognised
   * zone, or a player with no row yet, is a silent no-op. Call only after authentication.
   */
  recordTimezone(userId: string, timezone: string): Promise<void>;
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
