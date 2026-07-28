import { describe, it, expect } from 'vitest';
import {
  withRequestContext,
  getCurrentRequestContext,
  getCurrentTraceId,
  getCurrentClientMeta,
} from '../request-context.js';

const CLIENT_META = { ip: '203.0.113.7', userAgent: 'curl/8.4.0' };
const CONTEXT = { userId: 'user-1', traceId: 'trace-1', clientMeta: CLIENT_META };

describe('request context outside a request', () => {
  it('has no context', () => {
    expect(getCurrentRequestContext()).toBeUndefined();
  });

  it('has no trace id', () => {
    expect(getCurrentTraceId()).toBeUndefined();
  });

  it('reports empty client meta rather than throwing on a background path', () => {
    expect(getCurrentClientMeta()).toEqual({ ip: null, userAgent: null });
  });
});

describe('withRequestContext', () => {
  it('exposes the context to everything it wraps', () => {
    withRequestContext(CONTEXT, () => {
      expect(getCurrentRequestContext()).toEqual(CONTEXT);
      expect(getCurrentTraceId()).toBe('trace-1');
      expect(getCurrentClientMeta()).toEqual(CLIENT_META);
    });
  });

  it('returns whatever the wrapped function returns', () => {
    expect(withRequestContext(CONTEXT, () => 'result')).toBe('result');
  });

  it('tears the context down once the call finishes', () => {
    withRequestContext(CONTEXT, () => getCurrentTraceId());

    expect(getCurrentRequestContext()).toBeUndefined();
  });

  it('tears the context down even when the wrapped function throws', () => {
    expect(() =>
      withRequestContext(CONTEXT, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(getCurrentRequestContext()).toBeUndefined();
  });

  it('survives an await boundary inside the request', async () => {
    await withRequestContext(CONTEXT, async () => {
      await Promise.resolve();
      expect(getCurrentTraceId()).toBe('trace-1');
    });
  });

  it('keeps concurrent requests from seeing each other traces', async () => {
    const traceAfterDelay = (traceId: string) =>
      withRequestContext({ traceId }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return getCurrentTraceId();
      });

    expect(await Promise.all([traceAfterDelay('a'), traceAfterDelay('b')])).toEqual(['a', 'b']);
  });

  it('lets an inner request shadow the outer one and restores it after', () => {
    withRequestContext(CONTEXT, () => {
      withRequestContext({ traceId: 'inner' }, () => {
        expect(getCurrentTraceId()).toBe('inner');
      });
      expect(getCurrentTraceId()).toBe('trace-1');
    });
  });

  it('falls back to empty client meta when the request carries none', () => {
    withRequestContext({ traceId: 'trace-2' }, () => {
      expect(getCurrentClientMeta()).toEqual({ ip: null, userAgent: null });
    });
  });
});
