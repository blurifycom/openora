import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { call } from '@orpc/server';
import { sql } from 'drizzle-orm';
import type { AdminGuard } from '@openora/core/server';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { makeAdminGuard, makeAuditWriter, testContext } from '../../../testing/mock.js';
import { migrate as migratePlayerNote } from '../migrate.js';
import { createPlayerNoteRouter } from '../router/index.js';
import { playerNote } from '../schema/index.js';
import { PlayerNoteService } from '../service/player-note.service.js';

const CTX = testContext();
const CALLER = '44444444-4444-4444-8444-444444444444';
const PLAYER_ID = '11111111-1111-4111-8111-111111111111';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migratePlayerNote]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${playerNote} RESTART IDENTITY`);
});

const guardAllowing = (allow: readonly string[]) =>
  makeAdminGuard({ allow, caller: { userId: CALLER, ip: '127.0.0.1', userAgent: 'test' } });

function build(adminGuard: AdminGuard) {
  const audit = makeAuditWriter();
  return {
    router: createPlayerNoteRouter(new PlayerNoteService(db.drizzle), adminGuard, audit),
    audit,
  };
}

describe('player note router', () => {
  it('records adding an internal note in the audit log', async () => {
    const { router, audit } = build(guardAllowing(['player-note:create']));

    const created = await call(
      router.create,
      { playerId: PLAYER_ID, content: 'Contacted player about verification.' },
      { context: CTX },
    );

    expect(audit.record).toHaveBeenCalledWith({
      actorId: CALLER,
      actorType: 'admin',
      action: 'admin.player_note.created',
      resourceType: 'player',
      resourceId: PLAYER_ID,
      after: { noteId: created.id, content: created.content },
      ip: '127.0.0.1',
      userAgent: 'test',
    });
  });

  it('does not record an audit entry when permission is denied', async () => {
    const { router, audit } = build(guardAllowing([]));

    await expect(
      call(router.create, { playerId: PLAYER_ID, content: 'Private note' }, { context: CTX }),
    ).rejects.toBeDefined();

    expect(audit.record).not.toHaveBeenCalled();
  });
});
