import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '@openora/core/server';
import { chatRoomInvite } from '@openora/core/engagement/schema/chat';
import {
  ChatRoomInviteSchema,
  ChatRoomMemberSchema,
  ChatRoomSchema,
  MyChatRoomInviteSchema,
  type ChatRoom,
} from '@openora/core/engagement/contracts/chat';
import type { TestApp } from './app.js';
import type { TestClient } from './request.js';
import { registerChatter as registerChatterOn, type Chatter } from './helpers.js';

export const WAIT = { timeout: 10_000, interval: 100 };

/**
 * Private-room invite helpers shared by the invite e2e suites. `app` and `admin` are
 * booted in `beforeAll`, so they are read lazily through getters.
 */
export function chatInviteHelpers(getApp: () => TestApp, getAdmin: () => TestClient) {
  const registerChatter = (prefix: string, email?: string) =>
    registerChatterOn(getApp(), prefix, email);

  async function createRoom(owner: Chatter) {
    const created = await owner.client.post('/chat/rooms/private', {
      name: `room-${randomUUID()}`,
    });
    expect(created.status).toBe(200);
    return ChatRoomSchema.parse(await created.json());
  }

  async function joinByCode(member: Chatter, room: ChatRoom) {
    const joined = await member.client.post('/chat/rooms/join', { joinCode: room.joinCode });
    expect(joined.status).toBe(200);
  }

  async function configureRoom(
    owner: Chatter,
    room: ChatRoom,
    values: { moderatorInvite?: boolean; lockRoom?: boolean; onlyInvitedCanJoin?: boolean },
  ) {
    const res = await owner.client.patch(`/chat/rooms/${room.id}/configuration`, values);
    expect(res.status).toBe(200);
  }

  async function addModerator(owner: Chatter, room: ChatRoom) {
    const moderator = await registerChatter('keeper');
    await joinByCode(moderator, room);
    const promoted = await owner.client.post(
      `/chat/rooms/${room.id}/members/${moderator.userId}/role`,
      { role: 'moderator' },
    );
    expect(promoted.status).toBe(200);
    return moderator;
  }

  function invite(actor: Chatter, room: ChatRoom, userId: string) {
    return actor.client.post(`/chat/rooms/${room.id}/invites`, { userId });
  }

  async function sendInvite(actor: Chatter, room: ChatRoom, invitee: Chatter) {
    const res = await invite(actor, room, invitee.userId);
    expect(res.status).toBe(200);
    return ChatRoomInviteSchema.parse(await res.json());
  }

  async function expectRejected(res: Response, status: number, reason: string) {
    expect(res.status).toBe(status);
    const body = (await res.json()) as { data?: { reason?: string } };
    expect(body.data?.reason).toBe(reason);
  }

  async function myInvites(invitee: Chatter) {
    const res = await invitee.client.get('/chat/invites');
    expect(res.status).toBe(200);
    return MyChatRoomInviteSchema.array().parse(await res.json());
  }

  async function roomMemberIds(owner: Chatter, room: ChatRoom) {
    const res = await owner.client.get(`/chat/rooms/${room.id}/members`);
    expect(res.status).toBe(200);
    return ChatRoomMemberSchema.array()
      .parse(await res.json())
      .map((member) => member.userId);
  }

  async function inviteRow(inviteId: string) {
    const [row] = await getApp()
      .container.get(DRIZZLE)
      .db.select()
      .from(chatRoomInvite)
      .where(eq(chatRoomInvite.id, inviteId));
    return row;
  }

  async function auditRows(resourceId: string, action: string, actorId?: string) {
    const res = await getAdmin().get(
      `/audit/logs?resourceId=${resourceId}&action=${action}${actorId ? `&actorId=${actorId}` : ''}`,
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { items: unknown[] }).items;
  }

  return {
    registerChatter,
    createRoom,
    joinByCode,
    configureRoom,
    addModerator,
    invite,
    sendInvite,
    expectRejected,
    myInvites,
    roomMemberIds,
    inviteRow,
    auditRows,
  };
}
