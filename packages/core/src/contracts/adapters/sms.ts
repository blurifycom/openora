import { createToken, type Token } from './token.js';

export type SmsAdapter = {
  sendOtp(params: { to: string; code: string }): Promise<void>;
};

export const SMS_ADAPTER: Token<SmsAdapter> = createToken('SMS_ADAPTER');
