import { describe, it, expect, vi } from 'vitest';
import type { EventBus } from '@blurifycom/core/server';
import { TagService } from '../service/tag.service.js';
import { mock, mockDb } from '../../../testing/mock.js';

function makeDb(rows: unknown) {
  const builder: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return (res: (v: unknown) => unknown) => res(rows);
      return () => builder;
    },
    apply: () => builder,
  });
  return mockDb(builder);
}

function makeService(rows: unknown) {
  return new TagService(makeDb(rows), mock<EventBus>({ emit: vi.fn(), on: vi.fn() }));
}

describe('TagService.getActiveTagKeys', () => {
  it('groups active tag keys per user, keyed by auth userId', async () => {
    const svc = makeService([
      { userId: 'u-1', key: 'high_risk' },
      { userId: 'u-1', key: 'bonus_abuser' },
      { userId: 'u-2', key: 'vip' },
    ]);

    const map = await svc.getActiveTagKeys(['u-1', 'u-2', 'u-3']);

    expect(map.get('u-1')).toEqual(['high_risk', 'bonus_abuser']);
    expect(map.get('u-2')).toEqual(['vip']);
    // A user with no active tags is simply absent - callers treat that as "no tags".
    expect(map.has('u-3')).toBe(false);
  });

  it('returns an empty map without querying for an empty input', async () => {
    const svc = makeService([{ userId: 'u-1', key: 'high_risk' }]);
    const map = await svc.getActiveTagKeys([]);
    expect(map.size).toBe(0);
  });
});
