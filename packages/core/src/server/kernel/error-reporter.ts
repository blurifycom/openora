import type { ErrorContext } from '@openora/core/contracts';

// The process-wide bridge from the logger to a bound ERROR_TRACKING adapter;
// createApp sets it once after plugins load, when an overlay bound the port.
export type ErrorReporter = (error: unknown, context?: ErrorContext) => void;

let reporter: ErrorReporter | undefined;

export function setErrorReporter(next: ErrorReporter | undefined): void {
  reporter = next;
}

export function reportError(error: unknown, context?: ErrorContext): void {
  // Fire-and-forget: a reporter failure must never break the log call that drove it.
  try {
    reporter?.(error, context);
  } catch {
    /* swallow - reporting is best-effort */
  }
}
