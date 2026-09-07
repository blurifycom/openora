import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as z from 'zod';
import { sql } from 'drizzle-orm';
import { createLobbySectionCatalog, type LobbySectionDefinition } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate as migrateLobby } from '@openora/core/casino/migrate/lobby';
import { makeEventBus } from '../../../testing/mock.js';
import { lobbyLayout, lobbySection } from '../schema/index.js';
import {
  LobbyLayoutVersionConflictError,
  LobbySectionFieldError,
  LobbyService,
} from '../service/lobby.service.js';

const ACTOR = { ip: null, userAgent: null };
const heroConfigSchema = z
  .object({ title: z.string().min(1), items: z.array(z.string()) })
  .strict();

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrateLobby]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${lobbySection}, ${lobbyLayout} RESTART IDENTITY CASCADE`,
  );
});

function heroDefinition(): LobbySectionDefinition {
  return {
    type: 'hero',
    parseConfig: (config) => heroConfigSchema.parse(config),
    async validate(sections) {
      if (sections.some((section) => section.config['title'] === 'Forbidden')) {
        return { valid: false, message: 'forbidden title' };
      }
      return { valid: true };
    },
    async resolve(sections) {
      return new Map(
        sections.map((section) => [
          section.id,
          { ...heroConfigSchema.parse(section.config), resolved: true },
        ]),
      );
    },
  };
}

function service(definitions: LobbySectionDefinition[] = [heroDefinition()]) {
  const events = makeEventBus();
  return {
    svc: new LobbyService(db.drizzle, events, createLobbySectionCatalog(definitions)),
    events,
  };
}

function hero(title: string, items: string[] = [], isEnabled = true) {
  return { type: 'hero', config: { title, items }, isEnabled };
}

describe('LobbyService aggregate layout', () => {
  it('atomically creates, updates, orders, and deletes consumer-defined sections', async () => {
    const { svc } = service();
    const created = await svc.replaceLayout({
      version: 0,
      sections: [hero('First'), hero('Second')],
      ...ACTOR,
    });
    expect(created.version).toBe(1);
    expect(created.sections.map((section) => section.sortOrder)).toEqual([0, 1]);

    const second = created.sections[1];
    if (!second) {
      throw new Error('second section was not created');
    }
    const replaced = await svc.replaceLayout({
      version: 1,
      sections: [{ id: second.id, ...hero('Renamed', ['a']) }, hero('Third')],
      ...ACTOR,
    });
    expect(replaced.version).toBe(2);
    expect(replaced.sections).toHaveLength(2);
    expect(replaced.sections[0]).toMatchObject({
      id: second.id,
      config: { title: 'Renamed', items: ['a'] },
      sortOrder: 0,
    });
    expect(await svc.getAdminLayout()).toEqual(replaced);
  });

  it('rejects unknown types and invalid consumer configuration', async () => {
    const { svc } = service();
    await expect(
      svc.replaceLayout({
        version: 0,
        sections: [{ type: 'unknown', config: {}, isEnabled: true }],
        ...ACTOR,
      }),
    ).rejects.toThrow(LobbySectionFieldError);
    await expect(
      svc.replaceLayout({ version: 0, sections: [hero('', [])], ...ACTOR }),
    ).rejects.toThrow(LobbySectionFieldError);
    await expect(
      svc.replaceLayout({ version: 0, sections: [hero('Forbidden')], ...ACTOR }),
    ).rejects.toThrow(LobbySectionFieldError);
  });

  it('rejects stale and concurrent writers for the same version', async () => {
    const { svc } = service();
    const writes = await Promise.allSettled([
      svc.replaceLayout({ version: 0, sections: [hero('A')], ...ACTOR }),
      svc.replaceLayout({ version: 0, sections: [hero('B')], ...ACTOR }),
    ]);
    expect(writes.filter((write) => write.status === 'fulfilled')).toHaveLength(1);
    expect(writes.filter((write) => write.status === 'rejected')).toHaveLength(1);
    await expect(
      svc.replaceLayout({ version: 0, sections: [hero('C')], ...ACTOR }),
    ).rejects.toThrow(LobbyLayoutVersionConflictError);
  });

  it('resolves enabled sections through the consumer catalog', async () => {
    const { svc } = service();
    await svc.replaceLayout({
      version: 0,
      sections: [hero('Visible', ['one']), hero('Hidden', [], false)],
      ...ACTOR,
    });
    expect(await svc.getLayout()).toMatchObject([
      {
        type: 'hero',
        data: { title: 'Visible', items: ['one'], resolved: true },
      },
    ]);
  });

  it('emits one audit event with complete generic before and after states', async () => {
    const { svc, events } = service();
    const saved = await svc.replaceLayout({
      version: 0,
      sections: [hero('Audited')],
      ...ACTOR,
    });
    expect(events.emit).toHaveBeenCalledWith(
      'lobby.layout.updated',
      expect.objectContaining({ before: { version: 0, sections: [] }, after: saved }),
    );
  });
});
