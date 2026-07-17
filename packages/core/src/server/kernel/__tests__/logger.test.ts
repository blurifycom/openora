import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLogger } from '../logger.js';
import { setErrorReporter } from '../error-reporter.js';

afterEach(() => {
  setErrorReporter(undefined);
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
