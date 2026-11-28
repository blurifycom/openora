import { createToken, type Token } from './token.js';

export type LoginEnforcementPort = {
  block(userId: string, opts: { until: Date | null }, tx: unknown): Promise<void>;
  unblock(userId: string, tx: unknown): Promise<void>;
};

export const LOGIN_ENFORCEMENT: Token<LoginEnforcementPort> = createToken('LOGIN_ENFORCEMENT');
