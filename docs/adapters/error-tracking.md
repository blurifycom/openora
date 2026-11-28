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

Wiring: `createApp` (`packages/core/src/server/runtime/create-app.ts`) does this after plugins load. If
`ERROR_TRACKING` is bound, it resolves the tracker and installs it through `setErrorReporter`
(`packages/core/src/server/kernel/error-reporter.ts`) so each reported error reaches
`captureException` with its context.

No overlay binds `ERROR_TRACKING` -> no reporter -> error logs stay logs-only. The engine imports
no vendor SDK and has no `SENTRY_DSN`/vendor env of its own.

The forwarded `ErrorContext` carries `userId`/`traceId` from the active request context plus the
log's structured fields (event topic, path, message) as `extra`.

## Bind a vendor (consumer overlay)

Real vendor adapters live in the consumer, bound via a self-disabling overlay plugin - the same
pattern as the payment/KYC/realtime vendor overlays. Ship an `ErrorTrackingAdapter` impl and
provide it; loading the overlay last makes its binding win.

The overlay is a plugin with its own id (for example `sentry`) whose `register` reads the vendor DSN
from the environment and returns without providing anything when it is unset - self-disabling, so
the platform stays logs-only. When a DSN is set it provides `ERROR_TRACKING` with an adapter whose
`captureException` maps `ErrorContext` onto the vendor call: `userId` becomes the vendor user id,
`tags` are kept with `traceId` added as a `trace_id` tag, and `extra` is passed through. The port
and `ErrorContext` live in `packages/core/src/contracts/adapters/error-tracking.ts`.

A vendor SDK init (Sentry's, say) belongs in the factory, which `createApp` resolves once for the container that serves,
not in `register()`: a failed `SERVICE_MANIFEST` boot registers plugins into a container it then
drops (ADR-0049). Initialising in a file preloaded with `node --import` works as well.

Register it last in `extensions.config.ts` (a `kind: 'infra'` overlay). A PostHog/Rollbar shop
writes the equivalent overlay against the same port - core is unchanged.
