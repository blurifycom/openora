import type { SmsAdapter } from '@openora/core/contracts';

export class MockSmsAdapter implements SmsAdapter {
  async sendOtp({ to, code }: { to: string; code: string }): Promise<void> {
    console.log(`[SMS OTP] ${to}: ${code}`); // oxlint-disable-line no-console
  }
}
