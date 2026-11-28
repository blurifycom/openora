import { createToken, type Token } from './token.js';

export type SessionIdlePolicy = {
  touch(userId: string, sessionId: string): Promise<'active' | 'expired' | 'idle'>;
};

export const SESSION_IDLE_POLICY: Token<SessionIdlePolicy> = createToken('SESSION_IDLE_POLICY');
