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

`captureException` is fire-and-forget (returns `void`) - a reporter failure must never break
the request or background path that reported the error.

## Where the runtime captures

The engine (`createApp`) reports at the three seams that previously only logged to pino:

- oRPC unhandled-error interceptor - every route error that is not an expected `ORPCError`
  (mapped 4xx domain errors are skipped on purpose). Carries `userId` + `traceId` from the
  active request context.
- EventBus subscriber failures - a handler that throws is isolated and reported with a
  `path: 'event-subscriber'` tag plus the event topic.
- OutboxRelay drain failures - background publish failures, tagged `path: 'outbox-relay'`.

## Default binding

`ERROR_TRACKING` defaults to `NoopErrorTracker` - pino already logs at every seam, so the
reporter is purely additive and the platform runs unchanged without one.

When `SENTRY_DSN` is set, core auto-binds a Sentry reference tracker instead (same env-driven
auto-bind treatment as the Redis/BullMQ reference drivers). It dynamically imports
`@sentry/node`, so the vendor SDK is only loaded when a DSN is configured; `@sentry/node` is
an `optionalDependency` of `@openora/core` - install it in your app to activate the binding.
If the DSN is set but `@sentry/node` is missing, it logs a warning and falls back to the
no-op (boot never crashes).

Env vars:

- `SENTRY_DSN` - the project DSN. Required to activate. Lives in env, never in code.
- `SENTRY_TRACES_SAMPLE_RATE` - optional. `0..1`; unset means tracing is off (errors only).

`captureException` maps `ErrorContext` onto the Sentry scope: `userId -> user.id`,
`traceId -> tags.trace_id`, and `tags`/`extra` pass through.

> Deep auto-instrumentation (HTTP/DB spans) needs Sentry initialized via a `--import`
> preload hook before the app's other imports. That is a Sentry-specific consumer opt-in,
> deliberately outside this vendor-neutral seam. The in-process init here covers error
> capture and manual tracing.

## Override with another vendor (PostHog, Rollbar, ...)

Ship an impl of `ErrorTrackingAdapter` and bind it in an overlay plugin loaded AFTER core
(last registration wins). No DSN needed - your binding replaces the default outright.

```ts
// extensions/posthog-errors/plugin.ts
import { ERROR_TRACKING } from '@openora/core/contracts';
import { definePlugin } from '@openora/core/server';
import { PostHogErrorTracker } from './src/posthog-error-tracker.js';

export default definePlugin({
  id: 'posthog-errors',
  register(ctx) {
    ctx.provide(ERROR_TRACKING, () => new PostHogErrorTracker());
  },
});
```

Register it in `extensions.config.ts` as the last entry (an `kind: 'infra'` overlay).
