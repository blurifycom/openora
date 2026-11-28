import type { ErrorContext } from '@openora/core/contracts';

export type ErrorReporter = (error: unknown, context?: ErrorContext) => void;

let reporter: ErrorReporter | undefined;

export function setErrorReporter(next: ErrorReporter | undefined): void {
  reporter = next;
}

export function reportError(error: unknown, context?: ErrorContext): void {
  try {
    reporter?.(error, context);
  } catch {
    return;
  }
}
