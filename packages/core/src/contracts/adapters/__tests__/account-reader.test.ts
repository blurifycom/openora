import { describe, it, expect, vi } from 'vitest';
import { playerIdsOf, type AccountReader } from '../account-reader.js';

describe('playerIdsOf', () => {
  it('logs the error and how many ids failed, never the ids themselves', async () => {
    const warn = vi.fn();
    const failing = {
      getAccounts: () => Promise.reject(new Error('identity down')),
    } as unknown as AccountReader;
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];

    const result = await playerIdsOf(failing, { warn }).getPlayerIdsByUserIdsSafe(ids);

    expect(result.get(ids[0] ?? '')).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    const [context] = warn.mock.calls[0] ?? [];
    expect(context).toEqual({ err: expect.any(Error), count: 2 });
    expect(JSON.stringify(context)).not.toContain(ids[0]);
  });
});
