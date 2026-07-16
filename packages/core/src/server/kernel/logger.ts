import { pino, type Logger } from 'pino';
import { reportError } from './error-reporter.js';
import { getCurrentRequestContext } from './request-context.js';

const ERROR_LEVEL = 50;

// One logger.error({ err }, msg) both logs and reports: this hook forwards every
// error-level log carrying an `err` to the bound error reporter (an ERROR_TRACKING
// overlay - Sentry/PostHog/...), so no call site makes a separate capture call and
// child loggers are covered too. `report: false` opts a noisy/expected error out of
// forwarding (still logged); a log without `err` is never reported.
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
        const { err, report, ...rest } = first as {
          err?: unknown;
          report?: boolean;
        } & Record<string, unknown>;
        if (err === null || err === undefined || report === false) {
          return;
        }
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
