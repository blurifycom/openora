import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DrizzleDb } from '@openora/core/server';
import { AuditShipper } from '../service/audit-shipper.service.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('AuditShipper backoff', () => {
  it('doubles the delay after each failure, caps it at 5s and resets it on success', async () => {
    vi.useFakeTimers();
    const attempts: number[] = [];
    let failing = true;
    const transaction = vi.fn(async () => {
      attempts.push(Date.now());
      if (failing) {
        throw new Error('database down');
      }
      return null;
    });
    // Only `transaction` is reached: a null result is a round another shipper held.
    const db = { transaction } as unknown as DrizzleDb;
    const shipper = new AuditShipper(db, { intervalMs: 100, onError: () => {} });
    const start = Date.now();

    shipper.start();
    await vi.advanceTimersByTimeAsync(100 + 200 + 400 + 800 + 1_600 + 3_200 + 5_000 + 5_000);
    failing = false;
    await vi.advanceTimersByTimeAsync(5_000 + 100 + 100);
    await shipper.stop();

    const gaps = attempts.map((at, i) => at - (attempts[i - 1] ?? start));
    expect(gaps).toEqual([100, 200, 400, 800, 1_600, 3_200, 5_000, 5_000, 5_000, 100, 100]);
  });

  it('runs one loop after a stop and start that land while a drain is still in flight', async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const transaction = vi.fn(async () => {
      if (transaction.mock.calls.length === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return null;
    });
    const db = { transaction } as unknown as DrizzleDb;
    const shipper = new AuditShipper(db, { intervalMs: 100 });

    shipper.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(transaction).toHaveBeenCalledTimes(1);
    void shipper.stop();
    shipper.start();
    release?.();
    await vi.advanceTimersByTimeAsync(1_000);
    await shipper.stop();

    // The stale drain stops after its round; only the new loop ticks, once per 100 ms.
    expect(transaction).toHaveBeenCalledTimes(1 + 10);
  });
});
