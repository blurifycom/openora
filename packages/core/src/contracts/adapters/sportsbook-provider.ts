import * as z from 'zod';
import type { SportsbookProviderBetStatus } from '../schemas/sportsbook.js';
import { createToken, type Token } from './token.js';

export type SportsbookProviderSessionArgs = {
  sessionId: string;
  userId: string;
  currency: string;
  countryCode: string;
  expiresAt: string;
  locale?: string;
};

export const SportsbookProviderSessionSchema = z.object({
  token: z.string().min(1),
  launchUrl: z.url({ protocol: /^https$/ }).optional(),
});
export type SportsbookProviderSession = z.infer<typeof SportsbookProviderSessionSchema>;

export type SportsbookProvider = {
  name: string;
  issueSession(args: SportsbookProviderSessionArgs): Promise<SportsbookProviderSession>;
  revokeSession?(args: { sessionId: string; userId: string }): Promise<void>;
  getBetStatus?(args: { providerBetId: string }): Promise<SportsbookProviderBetStatus>;
};

export const SPORTSBOOK_PROVIDER: Token<SportsbookProvider> = createToken('SPORTSBOOK_PROVIDER');
