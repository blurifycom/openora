import { describe, expect, it } from 'vitest';
import {
  SUPPORT_HISTORY_FAILURE_REASONS,
  SupportChatProviderError,
  SupportHistoryProviderError,
} from '@openora/core/contracts';
import { reasonOf } from '../provider-reason.service.js';

describe('reasonOf', () => {
  it.each([
    new Error('vendor key sk_live_secret rejected'),
    'plain string',
    null,
    undefined,
    42,
    { reason: SUPPORT_HISTORY_FAILURE_REASONS[0] },
    Object.assign(new Error('x'), { reason: SUPPORT_HISTORY_FAILURE_REASONS[0] }),
  ])('hides everything about the foreign error %j', (err) => {
    expect(reasonOf(err)).toBe('unexpected adapter error');
  });

  it.each(SUPPORT_HISTORY_FAILURE_REASONS)(
    'keeps the listed reason %s of a history error',
    (reason) => {
      expect(reasonOf(new SupportHistoryProviderError(reason))).toBe(reason);
    },
  );

  it.each(SUPPORT_HISTORY_FAILURE_REASONS)(
    'keeps the listed reason %s of a chat error',
    (reason) => {
      expect(reasonOf(new SupportChatProviderError(reason))).toBe(reason);
    },
  );

  it.each(['token abc@example.com expired', '', 'TIMEOUT ', 'constructor', '__proto__'])(
    'never leaks the free text reason %j',
    (reason) => {
      const result = reasonOf(
        Object.assign(new SupportHistoryProviderError('timeout'), { reason }),
      );
      expect(result).toBe('unlisted reason');
    },
  );

  it('survives a reason getter that throws', () => {
    const err = new SupportHistoryProviderError('timeout');
    Object.defineProperty(err, 'reason', {
      get() {
        throw new Error('boom with a secret');
      },
    });
    expect(reasonOf(err)).toBe('unexpected adapter error');
  });

  it('survives an instanceof trap that throws', () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('trap');
        },
      },
    );
    expect(reasonOf(hostile)).toBe('unexpected adapter error');
  });

  it('ignores the message, cause and a rewritten name of a provider error', () => {
    const err = new SupportHistoryProviderError('timeout', { cause: new Error('secret') });
    err.name = 'sk_live_secret';
    err.message = 'sk_live_secret';
    expect(reasonOf(err)).toBe('timeout');
  });
});
