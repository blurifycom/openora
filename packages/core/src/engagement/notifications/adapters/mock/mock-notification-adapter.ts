// Logs to stdout only; replace via overlay. See docs/adapters/notification.md.
import type { NotificationDeliveryAdapter } from '@openora/core/contracts';

export class MockNotificationDeliveryAdapter implements NotificationDeliveryAdapter {
  async sendEmail(to: string, subject: string, _body: string) {
    process.stdout.write(JSON.stringify({ mock_email: true, to, subject }) + '\n');
  }
}
