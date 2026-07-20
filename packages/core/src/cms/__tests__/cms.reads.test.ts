import { describe, it, expect, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { mock, mockDb } from '../../testing/mock.js';
import type { EventBus } from '@openora/core/server';
import { InProcessCache } from '@openora/core/testing';
import { CmsService } from '../service/cms.service.js';

const dialect = new PgDialect();
const whereSql = (cond: SQL) => dialect.sqlToQuery(cond).sql;

function makeDb(rows: { pageV1: unknown; pageV2: unknown }) {
  const selectResults = [[rows.pageV1], [rows.pageV1], [rows.pageV2]];
  let selectCall = 0;

  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn(() => Promise.resolve(selectResults[selectCall++] ?? [])),
  };
  const updateChain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([rows.pageV2]),
  };

  return {
    select: vi.fn(() => selectChain),
    update: vi.fn(() => updateChain),
  };
}

describe('CmsService page cache invalidation', () => {
  it('updatePage invalidates the cached page so the next getPage reloads', async () => {
    const pageV1 = {
      id: 'p1',
      slug: 'about',
      title: 'About v1',
      content: {},
      publishedAt: null,
      createdAt: new Date('2024-01-01T00:00:00Z'),
    };
    const pageV2 = { ...pageV1, title: 'About v2' };

    const db = makeDb({ pageV1, pageV2 });
    const events = mock<EventBus>({ emit: vi.fn(), on: vi.fn() });
    const cache = new InProcessCache();
    const svc = new CmsService(mockDb(db), events, cache);

    const first = await svc.getPage('about');
    expect(first.title).toBe('About v1');

    // Second getPage within the ttl should hit the cache, not the db.
    const cachedAgain = await svc.getPage('about');
    expect(cachedAgain.title).toBe('About v1');
    expect(db.select).toHaveBeenCalledTimes(1);

    await svc.updatePage({ id: 'p1', title: 'About v2' }, 'admin-1');

    const afterUpdate = await svc.getPage('about');
    expect(afterUpdate.title).toBe('About v2');
    // 1 (first getPage) + 1 (updatePage's existing-row lookup) + 1 (reload post-invalidation)
    expect(db.select).toHaveBeenCalledTimes(3);

    cache.close();
  });
});

describe('CmsService public reads exclude drafts', () => {
  it('getPage filters on publishedAt IS NOT NULL and 404s a draft slug', async () => {
    let capturedWhere: SQL | undefined;
    const selectChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn((cond: SQL) => {
        capturedWhere = cond;
        return Promise.resolve([]);
      }),
    };
    const db = { select: vi.fn(() => selectChain) };
    const events = mock<EventBus>({ emit: vi.fn(), on: vi.fn() });
    const svc = new CmsService(mockDb(db), events);

    await expect(svc.getPage('draft-slug')).rejects.toThrow('Page not found: draft-slug');
    expect(capturedWhere && whereSql(capturedWhere)).toContain('"publishedAt" is not null');
  });

  it('listPages filters on publishedAt IS NOT NULL', async () => {
    let capturedWhere: SQL | undefined;
    const selectChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn((cond: SQL) => {
        capturedWhere = cond;
        return selectChain;
      }),
      orderBy: vi.fn(() => Promise.resolve([])),
    };
    const db = { select: vi.fn(() => selectChain) };
    const events = mock<EventBus>({ emit: vi.fn(), on: vi.fn() });
    const svc = new CmsService(mockDb(db), events);

    await svc.listPages();
    expect(capturedWhere && whereSql(capturedWhere)).toContain('"publishedAt" is not null');
  });
});
