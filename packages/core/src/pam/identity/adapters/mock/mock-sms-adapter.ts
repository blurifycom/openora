// Platform default: logs the OTP to stdout instead of sending a real SMS. Safe for
// dev/stage. Replace via overlay: ctx.provide(SMS_ADAPTER, () => new TwilioSmsAdapter()).
import type { SmsAdapter } from '@openora/core/contracts';

export class MockSmsAdapter implements SmsAdapter {
  async sendOtp({ to, code }: { to: string; code: string }): Promise<void> {
    // mock: log-to-stdout delivery until a real SMS vendor adapter is bound via overlay.
    console.log(`[SMS OTP] ${to}: ${code}`); // oxlint-disable-line no-console
  }
}
