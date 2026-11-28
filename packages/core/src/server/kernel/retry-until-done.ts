import { setTimeout as sleep } from 'node:timers/promises';

export async function retryUntilDone<T>(
  attempt: () => Promise<T>,
  options: {
    signal: AbortSignal;
    onFailure: (err: unknown, retryInMs: number) => void;
    firstDelayMs?: number;
    maxDelayMs?: number;
  },
): Promise<T | undefined> {
  const { signal, onFailure, firstDelayMs = 1_000, maxDelayMs = 60_000 } = options;
  for (let delay = firstDelayMs; !signal.aborted; delay = Math.min(delay * 2, maxDelayMs)) {
    try {
      return await attempt();
    } catch (err) {
      if (signal.aborted) {
        return undefined;
      }
      onFailure(err, delay);
    }
    await sleep(delay, undefined, { signal }).catch(() => undefined);
  }
  return undefined;
}
