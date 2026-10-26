import { describe, it, expect, vi, afterEach } from 'vitest';
import { TraceFlags, trace } from '@opentelemetry/api';
import { activeTraceLogFields, createLogger } from '../logger.js';
import { setErrorReporter } from '../error-reporter.js';

afterEach(() => {
  setErrorReporter(undefined);
  vi.restoreAllMocks();
});

describe('createLogger error-reporter hook', () => {
  it('forwards an error-level log carrying `err` to the bound reporter', () => {
    const reporter = vi.fn();
    setErrorReporter(reporter);

    const err = new Error('boom');
    createLogger('test').error({ err, event: 'x' }, 'something failed');

    expect(reporter).toHaveBeenCalledTimes(1);
    expect(reporter).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ extra: { event: 'x', message: 'something failed' } }),
    );
  });

  it('does not report error logs without an `err`', () => {
    const reporter = vi.fn();
    setErrorReporter(reporter);

    createLogger('test').error({ issues: [] }, 'validation failed');

    expect(reporter).not.toHaveBeenCalled();
  });

  it('does not report an error log opted out with `report: false`', () => {
    const reporter = vi.fn();
    setErrorReporter(reporter);

    createLogger('test').error({ err: new Error('boom'), report: false }, 'expected, retrying');

    expect(reporter).not.toHaveBeenCalled();
  });

  it('does not report non-error levels', () => {
    const reporter = vi.fn();
    setErrorReporter(reporter);

    createLogger('test').warn({ err: new Error('x') }, 'a warning');

    expect(reporter).not.toHaveBeenCalled();
  });

  it('swallows reporter failures', () => {
    setErrorReporter(() => {
      throw new Error('reporter failed');
    });

    expect(() =>
      createLogger('test').error({ err: new Error('x') }, 'reporter failure'),
    ).not.toThrow();
  });

  it('is inert when no reporter is bound', () => {
    expect(() => createLogger('test').error({ err: new Error('x') }, 'no reporter')).not.toThrow();
  });
});

describe('activeTraceLogFields', () => {
  it('adds the active span trace and span ids', () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const spanId = '00f067aa0ba902b7';
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue(
      trace.wrapSpanContext({ traceId, spanId, traceFlags: TraceFlags.SAMPLED }),
    );

    expect(activeTraceLogFields()).toEqual({ trace_id: traceId, span_id: spanId });
  });

  it('adds nothing outside a span', () => {
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue(undefined);

    expect(activeTraceLogFields()).toEqual({});
  });

  it('adds nothing for an invalid span context', () => {
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue(
      trace.wrapSpanContext({
        traceId: '0'.repeat(32),
        spanId: '0'.repeat(16),
        traceFlags: TraceFlags.NONE,
      }),
    );

    expect(activeTraceLogFields()).toEqual({});
  });
});
