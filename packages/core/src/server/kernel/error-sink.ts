import type { ErrorContext } from '@openora/core/contracts';

// The process-wide bridge from the logger to a bound ERROR_TRACKING adapter.
// createApp sets it once after plugins load (when an overlay bound the port);
// createLogger forwards every error-level log carrying an `err` here, so a single
// logger.error(...) both logs and reports - no separate capture call at each site.
export type ErrorSink = (error: unknown, context?: ErrorContext) => void;

// ponytail: module-global, single sink. Fine for the single-process, single-tenant
// runtime (ADR-0026); if the engine ever runs multiple isolated apps in one process,
// move this onto the container.
let sink: ErrorSink | undefined;

export function setErrorSink(next: ErrorSink | undefined): void {
  sink = next;
}

export function reportError(error: unknown, context?: ErrorContext): void {
  // Fire-and-forget: a reporter failure must never break the log call that drove it.
  try {
    sink?.(error, context);
  } catch {
    /* swallow - reporting is best-effort */
  }
}
