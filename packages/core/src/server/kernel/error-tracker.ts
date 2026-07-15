import type { ErrorTrackingAdapter, ErrorContext } from '@openora/core/contracts';
import { createLogger } from './logger.js';

// Default binding for ERROR_TRACKING. pino already logs at every failure seam, so
// the no-op tracker is purely additive - the platform runs unchanged without a
// reporter overlay.
export class NoopErrorTracker implements ErrorTrackingAdapter {
  captureException(_error?: unknown, _context?: ErrorContext): void {}
}

type SentryCaptureContext = {
  user?: { id: string };
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
};

// The slice of @sentry/node this adapter touches. The module is imported
// dynamically (optional dependency), so we type only what we call.
type SentryModule = {
  init(options: { dsn: string; tracesSampleRate?: number }): void;
  captureException(error: unknown, context?: SentryCaptureContext): void;
};

export type SentryErrorTrackerConfig = {
  dsn: string;
  tracesSampleRate?: number;
};

/**
 * Sentry reference error tracker. Dynamically imports @sentry/node so the vendor
 * dep is only pulled in when a DSN is configured, and tracing only activates when
 * tracesSampleRate is set. Falls back to a no-op if @sentry/node is not installed,
 * so a misconfigured DSN never crashes boot.
 */
// ponytail: in-process init gives error capture + manual tracing; deep
// auto-instrumentation (http/pg spans) needs a --import preload hook, opt-in on
// the consumer side. Add when APM spans are actually wanted.
export async function createSentryErrorTracker(
  config: SentryErrorTrackerConfig,
): Promise<ErrorTrackingAdapter> {
  const log = createLogger('sentry');
  // Non-literal specifier: keep the optional dep out of static module resolution
  // so typecheck/build never require @sentry/node to be present.
  const specifier: string = '@sentry/node';
  let sentry: SentryModule;
  try {
    sentry = await import(specifier);
  } catch {
    log.warn(
      'SENTRY_DSN is set but @sentry/node is not installed - error tracking disabled. ' +
        'Add @sentry/node to your app dependencies to enable it.',
    );
    return new NoopErrorTracker();
  }

  sentry.init({
    dsn: config.dsn,
    ...(config.tracesSampleRate !== undefined ? { tracesSampleRate: config.tracesSampleRate } : {}),
  });
  log.info('sentry error tracking active.');

  return {
    captureException(error: unknown, context?: ErrorContext): void {
      sentry.captureException(error, {
        ...(context?.userId ? { user: { id: context.userId } } : {}),
        tags: {
          ...context?.tags,
          ...(context?.traceId ? { trace_id: context.traceId } : {}),
        },
        ...(context?.extra ? { extra: context.extra } : {}),
      });
    },
  };
}
