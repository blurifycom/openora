# Notification Delivery Adapter

## Interface

```ts
// packages/core/src/contracts/adapters/src/notification.ts
export interface NotificationDeliveryAdapter {
  sendEmail(to: string, subject: string, body: string): Promise<void>;
}

export const NOTIFICATION_DELIVERY_ADAPTER = Symbol('NOTIFICATION_DELIVERY_ADAPTER');
```

## Default binding

The `notifications` module ships `MockNotificationDeliveryAdapter` (logs to stdout, never
sends real email). It is bound at boot via `notifications/src/plugin.ts`.

## Custom implementation

No vendor is prescribed. Pick whatever fits your stack (SMTP, SES, SendGrid, Postmark, etc.).

1. Create an overlay plugin:

```bash
/scaffold-plugin email-delivery
```

2. Implement `NotificationDeliveryAdapter`:

```ts
// apps/api/src/extensions/email-delivery/src/my-email-adapter.ts
import type { NotificationDeliveryAdapter } from '@oss/core/contracts';

export class MyEmailAdapter implements NotificationDeliveryAdapter {
  async sendEmail(to: string, subject: string, body: string): Promise<void> {
    // call your SMTP/SES/SendGrid/Postmark client here
  }
}
```

3. Bind it in the plugin, AFTER `notifications` in `extensions.config.ts`:

```ts
// apps/api/src/extensions/email-delivery/plugin.ts
import { NOTIFICATION_DELIVERY_ADAPTER } from '@oss/core/contracts';
import { definePlugin } from '@oss/core/server';
import { MyEmailAdapter } from './src/my-email-adapter.js';

export default definePlugin({
  id: 'email-delivery',
  dependsOn: ['notifications'],
  register(ctx) {
    ctx.provide(NOTIFICATION_DELIVERY_ADAPTER, () => new MyEmailAdapter());
  },
});
```

4. Register in `extensions.config.ts` **after** the `notifications` entry.

## Extending the interface

If you need richer delivery (SMS, push, templates), extend the adapter interface in
`@oss/core/contracts` and add a new token. Keep `sendEmail` in the existing interface for
backwards compatibility, or replace the token entirely in your overlay.
