// Error-tracking seam. The runtime reports unhandled errors here - the oRPC
// interceptor, event-subscriber failures, and outbox-relay drops. The default is
// a no-op; core ships a Sentry reference impl that auto-binds when SENTRY_DSN is
// set (mirroring the Redis/BullMQ reference drivers). Operators swap it for any
// vendor (PostHog, Rollbar, ...) via an overlay:
//   ctx.provide(ERROR_TRACKING, () => new MyErrorTracker())
// Load your overlay AFTER core so its binding wins (last registration wins).
import { createToken, type Token } from './token.js';

export type ErrorContext = {
  userId?: string;
  traceId?: string;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
};

// captureException is fire-and-forget (returns void) - a reporter failure must
// never break the request or background path that called it.
export type ErrorTrackingAdapter = {
  captureException(error: unknown, context?: ErrorContext): void;
};

export const ERROR_TRACKING: Token<ErrorTrackingAdapter> =
  createToken<ErrorTrackingAdapter>('ERROR_TRACKING');
