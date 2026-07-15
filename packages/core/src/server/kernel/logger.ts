import { pino, type Logger } from 'pino';
import { reportError } from './error-sink.js';
import { getCurrentRequestContext } from './request-context.js';

const ERROR_LEVEL = 50;

// Mirror every error-level log carrying an `err` to the bound error sink
// (Sentry/PostHog/... via an ERROR_TRACKING overlay). Wiring it into the logger
// means one logger.error({ err }, msg) both logs and reports - callers never make a
// separate capture call, and all error logs are covered, not just a hand-picked few.
// The hook fires for child loggers too. Logs without an `err` (validation notices,
// etc.) are not reported.
export function createLogger(name: string): Logger {
  return pino({
    name,
    hooks: {
      logMethod(inputArgs, method, level) {
        method.apply(this, inputArgs);
        if (level < ERROR_LEVEL) {
          return;
        }
        const [first, second] = inputArgs;
        if (!first || typeof first !== 'object' || !('err' in first)) {
          return;
        }
        const { err, ...rest } = first as { err: unknown } & Record<string, unknown>;
        const ctx = getCurrentRequestContext();
        const message = typeof second === 'string' ? second : undefined;
        reportError(err, {
          ...(ctx?.userId ? { userId: ctx.userId } : {}),
          ...(ctx?.traceId ? { traceId: ctx.traceId } : {}),
          extra: message ? { ...rest, message } : rest,
        });
      },
    },
  });
}
