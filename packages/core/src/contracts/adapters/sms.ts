/**
 * SMS delivery seam. The phone-login OTP flow sends codes through this adapter so the
 * transport is swappable: the platform default (bound in identity/plugin.ts) is a
 * log-to-stdout mock, safe for dev/stage. A consumer overlay rebinds SMS_ADAPTER to a
 * real vendor (Twilio, AWS SNS) in production. See AGENTS.md "third-party integration".
 */
import { createToken, type Token } from './token.js';

export type SmsAdapter = {
  sendOtp(params: { to: string; code: string }): Promise<void>;
};

export const SMS_ADAPTER: Token<SmsAdapter> = createToken('SMS_ADAPTER');
