// Error-tracking seam. Core names no vendor; a consumer binds one (Sentry, PostHog,
// Rollbar, ...) via an overlay plugin. Bound -> every error-level log carrying an
// `err` is reported (forwarded through the logger); unbound -> logs stay logs-only.
import { createToken, type Token } from './token.js';

export type ErrorContext = {
  userId?: string;
  traceId?: string;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
};

// Fire-and-forget - a reporter failure must never break the path that called it.
export type ErrorTrackingAdapter = {
  captureException(error: unknown, context?: ErrorContext): void;
};

export const ERROR_TRACKING: Token<ErrorTrackingAdapter> =
  createToken<ErrorTrackingAdapter>('ERROR_TRACKING');
