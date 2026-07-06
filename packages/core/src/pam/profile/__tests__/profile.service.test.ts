import { describe, it, expect, vi } from 'vitest';
import { ProfileService } from '../service/profile.service.js';

function chain(result: unknown): any {
  const proxy: any = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return (res: (v: unknown) => unknown) => res(result);
      return () => proxy;
    },
    apply: () => proxy,
  });
  return proxy;
}

const playerRow = {
  id: 'player-1',
  userId: 'user-1',
  displayName: 'Player One',
  country: null,
  currency: 'USD',
  status: 'active',
  kycStatus: 'pending',
  level: 1,
  totalWagered: '0',
  totalDeposits: '0',
  lastSeenAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeService(): ProfileService {
  const select = vi
    .fn()
    .mockReturnValueOnce(chain([playerRow]))
    .mockReturnValueOnce(chain([{ email: 'player@example.com' }]))
    .mockReturnValueOnce(chain([{ email: 'player@example.com' }]));
  const update = vi.fn(() => chain([{ ...playerRow, country: 'US' }]));
  const db = { select, update };
  return new ProfileService({ db } as never);
}

describe('ProfileService.updateMyProfile', () => {
  it('persists profile fields and returns the mapped player', async () => {
    const svc = makeService();
    const result = await svc.updateMyProfile('user-1', { country: 'US' });
    expect(result.country).toBe('US');
    expect(result.email).toBe('player@example.com');
  });
});
