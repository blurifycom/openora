import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NoopErrorTracker, createSentryErrorTracker } from '../error-tracker.js';

describe('NoopErrorTracker', () => {
  it('is inert', () => {
    const tracker = new NoopErrorTracker();
    expect(() => tracker.captureException(new Error('x'))).not.toThrow();
  });
});

const init = vi.fn();
const captureException = vi.fn();

// The adapter loads '@sentry/node' via a runtime dynamic import(); vitest's module
// registry intercepts it regardless of the specifier being non-literal.
vi.mock('@sentry/node', () => ({ init, captureException }));

describe('createSentryErrorTracker', () => {
  beforeEach(() => {
    init.mockReset();
    captureException.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('inits Sentry with the dsn and no tracing by default', async () => {
    await createSentryErrorTracker({ dsn: 'https://k@example/1' });
    expect(init).toHaveBeenCalledWith({ dsn: 'https://k@example/1' });
  });

  it('passes tracesSampleRate through when set', async () => {
    await createSentryErrorTracker({ dsn: 'https://k@example/1', tracesSampleRate: 0.5 });
    expect(init).toHaveBeenCalledWith({ dsn: 'https://k@example/1', tracesSampleRate: 0.5 });
  });

  it('maps userId, traceId and tags onto the Sentry scope', async () => {
    const tracker = await createSentryErrorTracker({ dsn: 'https://k@example/1' });
    const err = new Error('boom');
    tracker.captureException(err, {
      userId: 'u1',
      traceId: 't1',
      tags: { path: 'orpc' },
      extra: { route: '/x' },
    });
    expect(captureException).toHaveBeenCalledWith(err, {
      user: { id: 'u1' },
      tags: { path: 'orpc', trace_id: 't1' },
      extra: { route: '/x' },
    });
  });

  it('omits user when no userId is given', async () => {
    const tracker = await createSentryErrorTracker({ dsn: 'https://k@example/1' });
    tracker.captureException(new Error('boom'));
    const [, ctx] = captureException.mock.calls[0] ?? [];
    expect(ctx).not.toHaveProperty('user');
  });
});
