// Error-tracking seam. Core names no vendor: every error-level log carrying an
// `err` is forwarded here (wired through the logger), so binding this port reports
// all error logs - the oRPC interceptor, event-subscriber failures, outbox-relay
// drops, and any other logger.error({ err }). Unbound -> error logs stay logs-only.
// A consumer binds a vendor (Sentry, PostHog, Rollbar, ...) via an overlay plugin:
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
