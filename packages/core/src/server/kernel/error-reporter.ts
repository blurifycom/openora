import type { ErrorContext } from '@openora/core/contracts';

// The process-wide bridge from the logger to a bound ERROR_TRACKING adapter;
// createApp sets it once after plugins load, when an overlay bound the port.
export type ErrorReporter = (error: unknown, context?: ErrorContext) => void;

// ponytail: process-global single reporter. Correct under horizontal scaling - each
// replica is its own process with its own reporter, reporting independently (the vendor
// aggregates across instances). The only limit is multiple createApp instances in ONE
// process (multi-tenant hosting, or a test harness booting several apps): they'd share
// this reporter and one app's dispose would clear it for the others. Move it onto the
// container then. See ADR-0026.
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
