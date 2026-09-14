import { pino, levels, type Logger } from 'pino';
import { reportError } from './error-reporter.js';
import { getCurrentRequestContext } from './request-context.js';

/**
 * One logger.error({ err }, msg) both logs and reports: this hook forwards every
 * error-level log carrying an `err` to the bound error reporter (an ERROR_TRACKING
 * overlay - Sentry/PostHog/...), so no call site makes a separate capture call and
 * child loggers are covered too. `report: false` opts a noisy/expected error out of
 * forwarding (still logged); a log without `err` is never reported.
 */
/**
 * pino reads no environment of its own; this is where LOG_LEVEL is honoured.
 *
 * `silent` is served by discarding the output rather than by pino's own silent level:
 * a disabled level never reaches `logMethod`, and the error-reporter hook below lives
 * there - so asking for quiet logs would silently also stop reporting errors to the
 * bound tracker. The test suites run at this setting.
 */
const DISCARD = { write() {} };

function levelAndDestination(): [string, typeof DISCARD | undefined] {
  const level = process.env['LOG_LEVEL'] ?? 'info';
  return level === 'silent' ? ['info', DISCARD] : [level, undefined];
}

export function createLogger(name: string): Logger {
  const [level, destination] = levelAndDestination();
  return pino(
    {
      name,
      level,
      hooks: {
        logMethod(inputArgs, method, level) {
          method.apply(this, inputArgs);

          if (level < levels.values['error']) {
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
          if (!err || report === false) {
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
    },
    destination,
  );
}
