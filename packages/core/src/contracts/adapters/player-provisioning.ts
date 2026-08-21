import { createToken, type Token } from './token.js';

export type PlayerProvisioning = {
  createForRegistration(record: PlayerRegistrationRecord): Promise<void>;
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
