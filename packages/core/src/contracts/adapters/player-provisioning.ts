import type { RegistrationAcquisition } from '../schemas/identity.js';
import { createToken, type Token } from './token.js';

export type PlayerProvisioning = {
  createForRegistration(
    record: PlayerRegistrationRecord,
    onCreated?: (tx: unknown, playerId: string) => Promise<void>,
  ): Promise<{ created: boolean; playerId?: string }>;

  recordTimezone?(userId: string, timezone: string): Promise<void>;
};

export type PlayerRegistrationRecord = {
  userId: string;
  termsVersion: string;
  termsAcceptedAt: Date;
  ageAcceptedAt: Date;
  registrationIp: string | null;
  registrationUserAgent: string | null;
  acquisition?: RegistrationAcquisition;
};

export const PLAYER_PROVISIONING: Token<PlayerProvisioning> = createToken('PLAYER_PROVISIONING');
