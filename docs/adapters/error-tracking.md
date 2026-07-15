# Error-Tracking Adapter

## Interface

```ts
// packages/core/src/contracts/adapters/error-tracking.ts
import { createToken, type Token } from './token.js';

export type ErrorContext = {
  userId?: string;
  traceId?: string;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
};

export type ErrorTrackingAdapter = {
  captureException(error: unknown, context?: ErrorContext): void;
};

export const ERROR_TRACKING: Token<ErrorTrackingAdapter> = createToken('ERROR_TRACKING');
```

`captureException` is fire-and-forget (returns `void`) - a reporter failure never breaks the
path that reported the error. Core names **no vendor**: the port is the only seam. Sentry,
PostHog, Rollbar, etc. are consumer overlays.

## How reporting flows (no per-call-site capture)

Core does not call `captureException` at each failure site. Instead the logger is the bridge:
every `logger.error({ err, ... }, 'message')` is mirrored to the bound tracker. So one log call
both logs and reports, and **all** error logs are covered - the oRPC unhandled-error
interceptor, EventBus subscriber failures, OutboxRelay drops, and anything else that logs an
error with an `err` field. Error logs without an `err` (validation notices) are not reported.

Wiring, in `createApp`, after plugins load:

```ts
if (container.has(ERROR_TRACKING)) {
  const tracker = container.get(ERROR_TRACKING);
  setErrorSink((error, context) => tracker.captureException(error, context));
}
```

No overlay binds `ERROR_TRACKING` -> no sink -> error logs stay logs-only. The engine imports
no vendor SDK and has no `SENTRY_DSN`/vendor env of its own.

The forwarded `ErrorContext` carries `userId`/`traceId` from the active request context plus the
log's structured fields (event topic, path, message) as `extra`.

## Bind a vendor (consumer overlay)

Real vendor adapters live in the consumer, bound via a self-disabling overlay plugin - the same
pattern as the payment/KYC/realtime vendor overlays. Ship an `ErrorTrackingAdapter` impl and
provide it; loading the overlay last makes its binding win.

```ts
// extensions/sentry/plugin.ts (consumer)
import { ERROR_TRACKING } from '@openora/core/contracts';
import { definePlugin } from '@openora/core/server';
import * as Sentry from '@sentry/node';

export default definePlugin({
  id: 'sentry',
  register(ctx) {
    const dsn = process.env['SENTRY_DSN'];
    if (!dsn) {
      return; // self-disabling: no DSN -> platform stays logs-only
    }
    Sentry.init({ dsn });
    ctx.provide(ERROR_TRACKING, () => ({
      captureException(error, context) {
        Sentry.captureException(error, {
          ...(context?.userId ? { user: { id: context.userId } } : {}),
          tags: { ...context?.tags, ...(context?.traceId ? { trace_id: context.traceId } : {}) },
          ...(context?.extra ? { extra: context.extra } : {}),
        });
      },
    }));
  },
});
```

Register it last in `extensions.config.ts` (a `kind: 'infra'` overlay). A PostHog/Rollbar shop
writes the equivalent overlay against the same port - core is unchanged.
