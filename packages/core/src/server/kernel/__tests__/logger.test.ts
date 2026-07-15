import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLogger } from '../logger.js';
import { setErrorSink } from '../error-sink.js';

afterEach(() => {
  setErrorSink(undefined);
});

describe('createLogger error-sink hook', () => {
  it('forwards an error-level log carrying `err` to the bound sink', () => {
    const sink = vi.fn();
    setErrorSink(sink);

    const err = new Error('boom');
    createLogger('test').error({ err, event: 'x' }, 'something failed');

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ extra: { event: 'x', message: 'something failed' } }),
    );
  });

  it('does not report error logs without an `err`', () => {
    const sink = vi.fn();
    setErrorSink(sink);

    createLogger('test').error({ issues: [] }, 'validation failed');

    expect(sink).not.toHaveBeenCalled();
  });

  it('does not report non-error levels', () => {
    const sink = vi.fn();
    setErrorSink(sink);

    createLogger('test').warn({ err: new Error('x') }, 'a warning');

    expect(sink).not.toHaveBeenCalled();
  });

  it('swallows sink failures', () => {
    setErrorSink(() => {
      throw new Error('sink failed');
    });

    expect(() => createLogger('test').error({ err: new Error('x') }, 'sink failure')).not.toThrow();
  });

  it('is inert when no sink is bound', () => {
    expect(() => createLogger('test').error({ err: new Error('x') }, 'no sink')).not.toThrow();
  });
});
