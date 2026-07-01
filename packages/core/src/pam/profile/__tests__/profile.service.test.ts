import { describe, it, expect, vi } from 'vitest';
import { ProfileService, UnsupportedLanguageError } from '../service/profile.service.js';

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
  language: 'en',
  status: 'active',
  kycStatus: 'pending',
  level: 1,
  totalWagered: '0',
  totalDeposits: '0',
  lastSeenAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeService(supportedLanguages?: string[]): ProfileService {
  const select = vi
    .fn()
    .mockReturnValueOnce(chain([playerRow]))
    .mockReturnValueOnce(chain([{ email: 'player@example.com' }]))
    .mockReturnValueOnce(chain([{ email: 'player@example.com' }]));
  const update = vi.fn(() => chain([{ ...playerRow, language: 'es' }]));
  const db = { select, update };
  const platformConfig = supportedLanguages ? { supportedLanguages } : undefined;
  return new ProfileService({ db } as never, platformConfig as never);
}

describe('ProfileService.updateMyProfile language validation', () => {
  it('accepts any language when no supportedLanguages is configured', async () => {
    const svc = makeService();
    const result = await svc.updateMyProfile('user-1', { language: 'es' });
    expect(result.language).toBe('es');
  });

  it('accepts a language within the configured list', async () => {
    const svc = makeService(['en', 'es']);
    const result = await svc.updateMyProfile('user-1', { language: 'es' });
    expect(result.language).toBe('es');
  });

  it('rejects a language outside the configured list', async () => {
    const svc = makeService(['en', 'fr']);
    await expect(svc.updateMyProfile('user-1', { language: 'de' })).rejects.toThrow(
      UnsupportedLanguageError,
    );
  });
});
