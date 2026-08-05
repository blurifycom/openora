# Notification Delivery Adapter

## Interface

Source of truth: [`packages/core/src/contracts/adapters/notification.ts`](../../packages/core/src/contracts/adapters/notification.ts) - `NotificationDeliveryAdapter` and the `NOTIFICATION_DELIVERY_ADAPTER` token.

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
import type { NotificationDeliveryAdapter } from '@openora/core/contracts';

export class MyEmailAdapter implements NotificationDeliveryAdapter {
  async sendEmail(to: string, subject: string, body: string): Promise<void> {
    // call your SMTP/SES/SendGrid/Postmark client here
  }
}
```

3. Bind it in the plugin, AFTER `notifications` in `extensions.config.ts`:

```ts
// apps/api/src/extensions/email-delivery/plugin.ts
import { NOTIFICATION_DELIVERY_ADAPTER } from '@openora/core/contracts';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { MyEmailAdapter } from './src/my-email-adapter.js';

export default {
  id: 'email-delivery',
  dependsOn: ['notifications'],
  register(ctx) {
    ctx.provide(NOTIFICATION_DELIVERY_ADAPTER, () => new MyEmailAdapter());
  },
} as const satisfies Plugin<CoreTokenCatalog>;
```

4. Register in `extensions.config.ts` **after** the `notifications` entry.

## Extending the interface

If you need richer delivery (SMS, push, templates), extend the adapter interface in
`@openora/core/contracts` and add a new token. Keep `sendEmail` in the existing interface for
backwards compatibility, or replace the token entirely in your overlay.
