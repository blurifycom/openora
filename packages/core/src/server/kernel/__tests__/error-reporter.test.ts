import { describe, it, expect, vi, afterEach } from 'vitest';
import { setErrorReporter, reportError } from '../error-reporter.js';

afterEach(() => {
  setErrorReporter(undefined);
});

describe('reportError', () => {
  it('is a no-op when no reporter is bound', () => {
    expect(() => reportError(new Error('boom'))).not.toThrow();
  });

  it('forwards the error to the bound reporter', () => {
    const reporter = vi.fn();
    setErrorReporter(reporter);
    const error = new Error('boom');

    reportError(error);

    expect(reporter).toHaveBeenCalledWith(error, undefined);
  });

  it('forwards the context alongside the error', () => {
    const reporter = vi.fn();
    setErrorReporter(reporter);

    reportError(new Error('boom'), { userId: 'user-1' });

    expect(reporter).toHaveBeenCalledWith(expect.any(Error), { userId: 'user-1' });
  });

  it('swallows a reporter failure so logging never breaks the request', () => {
    setErrorReporter(() => {
      throw new Error('vendor sdk is down');
    });

    expect(() => reportError(new Error('boom'))).not.toThrow();
  });

  it('stops reporting once the reporter is cleared', () => {
    const reporter = vi.fn();
    setErrorReporter(reporter);
    setErrorReporter(undefined);

    reportError(new Error('boom'));

    expect(reporter).not.toHaveBeenCalled();
  });

  it('replaces the previous reporter rather than fanning out to both', () => {
    const first = vi.fn();
    const second = vi.fn();
    setErrorReporter(first);
    setErrorReporter(second);

    reportError(new Error('boom'));

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it('reports a non-Error rejection value as-is', () => {
    const reporter = vi.fn();
    setErrorReporter(reporter);

    reportError('connection terminated');

    expect(reporter).toHaveBeenCalledWith('connection terminated', undefined);
  });
});
