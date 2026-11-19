import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, EVENT_BUS } from '@openora/core/server';
import { player } from '@openora/core/pam/schema/profile';
import { chatRoomMember } from '@openora/core/engagement/schema/chat';
import { bootE2e, closeE2e, type TestApp, type TestDb } from '../index.js';
import { WAIT, chatInviteHelpers } from '../chat-invite-helpers.js';

let db: TestDb;
let app: TestApp;

const { registerChatter, createRoom, joinByCode } = chatInviteHelpers(
  () => app,
  () => {
    throw new Error('no admin client in this suite');
  },
);

beforeAll(async () => {
  ({ db, app } = await bootE2e());
}, 60_000);

afterAll(async () => {
  await closeE2e({ app, db });
});

async function closedAt(roomId: string, userId: string) {
  const [member] = await app.container
    .get(DRIZZLE)
    .db.select({ accountClosedAt: chatRoomMember.accountClosedAt })
    .from(chatRoomMember)
    .where(and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, userId)));
  return member?.accountClosedAt ?? null;
}

/** The account's real state: chat acts on it, not on the event that announced it. */
async function setPlayerStatus(playerId: string, status: 'active' | 'closed') {
  await app.container.get(DRIZZLE).db.update(player).set({ status }).where(eq(player.id, playerId));
}

describe('chat reacting to an account closed and reopened', () => {
  it('handles every close and reopen, even when they happen on one day', async () => {
    const owner = await registerChatter('host');
    const member = await registerChatter('guest');
    const room = await createRoom(owner);
    await joinByCode(member, room);
    const ids = { userId: member.userId, playerId: member.playerId, actorId: owner.userId };
    const events = app.container.get(EVENT_BUS);

    for (const [event, closed] of [
      ['player.account.closed', true],
      ['player.account.reopened', false],
      ['player.account.closed', true],
      ['player.account.reopened', false],
      ['player.account.closed', true],
    ] as const) {
      await setPlayerStatus(member.playerId, closed ? 'closed' : 'active');
      events.emit(event, ids);
      await vi.waitFor(async () => {
        expect(await closedAt(room.id, member.userId)).toEqual(closed ? expect.any(Date) : null);
      }, WAIT);
    }
  });

  it('does not lock an account that is open again when its close event arrives late', async () => {
    const owner = await registerChatter('host');
    const member = await registerChatter('guest');
    const room = await createRoom(owner);
    await joinByCode(member, room);
    const events = app.container.get(EVENT_BUS);
    const marker = await registerChatter('marker');
    await joinByCode(marker, room);

    await setPlayerStatus(member.playerId, 'active');
    events.emit('player.account.closed', {
      userId: member.userId,
      playerId: member.playerId,
      actorId: owner.userId,
    });
    // A later close for a different member proves the late one was processed before we look.
    await setPlayerStatus(marker.playerId, 'closed');
    events.emit('player.account.closed', {
      userId: marker.userId,
      playerId: marker.playerId,
      actorId: owner.userId,
    });
    await vi.waitFor(async () => {
      expect(await closedAt(room.id, marker.userId)).toEqual(expect.any(Date));
    }, WAIT);

    expect(await closedAt(room.id, member.userId)).toBeNull();
  });

  it('keeps an account locked when its reopen event arrives while it is closed again', async () => {
    const owner = await registerChatter('host');
    const member = await registerChatter('guest');
    const room = await createRoom(owner);
    await joinByCode(member, room);
    const marker = await registerChatter('marker');
    await joinByCode(marker, room);
    const events = app.container.get(EVENT_BUS);
    for (const who of [member, marker]) {
      await setPlayerStatus(who.playerId, 'closed');
      events.emit('player.account.closed', {
        userId: who.userId,
        playerId: who.playerId,
        actorId: owner.userId,
      });
      await vi.waitFor(async () => {
        expect(await closedAt(room.id, who.userId)).toEqual(expect.any(Date));
      }, WAIT);
    }

    events.emit('player.account.reopened', {
      userId: member.userId,
      playerId: member.playerId,
      actorId: owner.userId,
    });
    await setPlayerStatus(marker.playerId, 'active');
    events.emit('player.account.reopened', {
      userId: marker.userId,
      playerId: marker.playerId,
      actorId: owner.userId,
    });
    await vi.waitFor(async () => {
      expect(await closedAt(room.id, marker.userId)).toBeNull();
    }, WAIT);

    expect(await closedAt(room.id, member.userId)).toEqual(expect.any(Date));
  });
});
