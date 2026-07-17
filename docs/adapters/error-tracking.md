# Error-Tracking Adapter

## Interface

Source of truth: [`packages/core/src/contracts/adapters/error-tracking.ts`](../../packages/core/src/contracts/adapters/error-tracking.ts) - `ErrorTrackingAdapter`, `ErrorContext`, and the `ERROR_TRACKING` token.

`captureException` is fire-and-forget (returns `void`) - a reporter failure never breaks the
path that reported the error. Core names **no vendor**: the port is the only seam. Sentry,
PostHog, Rollbar, etc. are consumer overlays.

## How reporting flows (no per-call-site capture)

Core does not call `captureException` at each failure site. Instead the logger is the bridge:
every `logger.error({ err, ... }, 'message')` is mirrored to the bound tracker. So one log call
both logs and reports, and **all** error logs are covered - the oRPC unhandled-error
interceptor, EventBus subscriber failures, OutboxRelay drops, and anything else that logs an
error with an `err` field. Error logs without an `err` (validation notices) are not reported.

Every unhandled error is caught at one of three global seams - never per-call-site in a module:

- **oRPC `onError` interceptor** - every route/service error; `handler.handle` maps it to a
  response, and non-`ORPCError`s are logged (expected `ORPCError`s are not reported).
- **Hono `app.onError`** - anything thrown in the middleware chain before oRPC runs (session
  resolution, raw-body capture, etag/cache); returns a 500 and reports non-`HTTPException` errors.
- **EventBus / OutboxRelay** - async subscriber and outbox-drain failures.

A module never writes tracker-specific code: it throws a typed error (caught by the interceptor)
or logs with `logger.error({ err })`. To opt an expected/noisy error out of forwarding - a caught
third-party timeout you log-and-retry - pass `report: false`: `logger.error({ err, report: false },
'psp timeout, retrying')` is still logged, just not sent to the tracker (so it doesn't burn quota).

Wiring, in `createApp`, after plugins load:

```ts
if (container.has(ERROR_TRACKING)) {
  const tracker = container.get(ERROR_TRACKING);
  setErrorReporter((error, context) => tracker.captureException(error, context));
}
```

No overlay binds `ERROR_TRACKING` -> no reporter -> error logs stay logs-only. The engine imports
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
