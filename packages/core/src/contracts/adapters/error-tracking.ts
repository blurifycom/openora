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

export const ERROR_TRACKING: Token<ErrorTrackingAdapter> =
  createToken<ErrorTrackingAdapter>('ERROR_TRACKING');
