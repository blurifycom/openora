import { describe, it, expect, vi } from 'vitest';
import { InProcessRateLimiter } from '../rate-limiter.js';

const OPTS = { limit: 3, windowMs: 1000 };

describe('InProcessRateLimiter', () => {
  it('allows calls up to the limit', async () => {
    const limiter = new InProcessRateLimiter();
    for (let i = 0; i < 3; i++) {
      await expect(limiter.consume('k', OPTS)).resolves.toEqual({ allowed: true, retryAfterMs: 0 });
    }
    limiter.close();
  });

  it('denies the call past the limit and reports the wait until the window resets', async () => {
    vi.useFakeTimers();
    const limiter = new InProcessRateLimiter();
    for (let i = 0; i < 3; i++) {
      await limiter.consume('k', OPTS);
    }
    vi.advanceTimersByTime(400);
    await expect(limiter.consume('k', OPTS)).resolves.toEqual({
      allowed: false,
      retryAfterMs: 600,
    });
    limiter.close();
    vi.useRealTimers();
  });

  it('a denied call does not extend the window', async () => {
    vi.useFakeTimers();
    const limiter = new InProcessRateLimiter();
    for (let i = 0; i < 3; i++) {
      await limiter.consume('k', OPTS);
    }
    vi.advanceTimersByTime(500);
    await limiter.consume('k', OPTS);
    vi.advanceTimersByTime(500);
    await expect(limiter.consume('k', OPTS)).resolves.toMatchObject({ allowed: true });
    limiter.close();
    vi.useRealTimers();
  });

  it('rolls over into a fresh window once the current one elapses', async () => {
    vi.useFakeTimers();
    const limiter = new InProcessRateLimiter();
    for (let i = 0; i < 3; i++) {
      await limiter.consume('k', OPTS);
    }
    await expect(limiter.consume('k', OPTS)).resolves.toMatchObject({ allowed: false });
    vi.advanceTimersByTime(1000);
    await expect(limiter.consume('k', OPTS)).resolves.toEqual({ allowed: true, retryAfterMs: 0 });
    limiter.close();
    vi.useRealTimers();
  });

  it('keys are isolated - exhausting one leaves another untouched', async () => {
    const limiter = new InProcessRateLimiter();
    for (let i = 0; i < 3; i++) {
      await limiter.consume('a', OPTS);
    }
    await expect(limiter.consume('a', OPTS)).resolves.toMatchObject({ allowed: false });
    await expect(limiter.consume('b', OPTS)).resolves.toMatchObject({ allowed: true });
    limiter.close();
  });

  it('reset clears a key back to a full allowance', async () => {
    const limiter = new InProcessRateLimiter();
    for (let i = 0; i < 3; i++) {
      await limiter.consume('k', OPTS);
    }
    await expect(limiter.consume('k', OPTS)).resolves.toMatchObject({ allowed: false });
    await limiter.reset('k');
    await expect(limiter.consume('k', OPTS)).resolves.toEqual({ allowed: true, retryAfterMs: 0 });
    limiter.close();
  });

  it('the sweep drops elapsed windows that are never consumed again', async () => {
    vi.useFakeTimers();
    const limiter = new InProcessRateLimiter();
    for (let i = 0; i < 3; i++) {
      await limiter.consume('k', OPTS);
    }
    // Past the window and the 60s sweep interval, without touching the key.
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(limiter.consume('k', OPTS)).resolves.toEqual({ allowed: true, retryAfterMs: 0 });
    limiter.close();
    vi.useRealTimers();
  });
});
