// Logs to stdout only; replace via overlay. See docs/adapters/notification.md.
import type { NotificationDeliveryAdapter } from '@blurifycom/core/contracts';

export class MockNotificationDeliveryAdapter implements NotificationDeliveryAdapter {
  async sendEmail(to: string, subject: string, _body: string): Promise<void> {
    process.stdout.write(JSON.stringify({ mock_email: true, to, subject }) + '\n');
  }
}
