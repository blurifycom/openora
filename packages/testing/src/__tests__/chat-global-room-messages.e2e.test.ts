import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import * as z from 'zod';
import { DRIZZLE } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import {
  AdminChatMessageSchema,
  ChatMessageSchema,
  ChatModerationEntrySchema,
  ChatRoomInviteSchema,
  ChatRoomSchema,
  MyChatRoomInviteSchema,
} from '@openora/core/engagement/contracts/chat';
import {
  chatMessage,
  chatMute,
  chatPlatformBan,
  chatPlayerCooldown,
  chatRoomInvite,
  chatUserBlock,
} from '@openora/core/engagement/schema/chat';
import {
  asAdmin,
  bootE2e,
  closeE2e,
  flushAudit,
  newStaff,
  registerChatter,
  type Chatter,
  type E2e,
  type TestClient,
} from '../index.js';
import { ErrorBodySchema } from './support/identity.js';

let e2e: E2e;
let admin: TestClient;

beforeAll(async () => {
  e2e = await bootE2e();
  admin = await asAdmin(e2e.app.app);
}, 60_000);

afterAll(() => closeE2e(e2e));

const db = () => e2e.app.container.get(DRIZZLE).db;
const MessagesSchema = z.array(ChatMessageSchema);
const PageOf = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), total: z.number() });
const NotificationsSchema = PageOf(
  z.object({ type: z.string(), params: z.record(z.string(), z.unknown()).nullable() }),
);
const BlockedPageSchema = PageOf(z.object({ blockedId: z.string() }));
const RestrictionReasonSchema = ErrorBodySchema.extend({
  data: z.object({ reason: z.string() }).loose(),
});

const chatter = (prefix: string) => registerChatter(e2e.app, prefix);
const FILTER_SAFE_DIGITS = '2689';
const uniqueText = (label: string) =>
  `${label} ${Array.from({ length: 16 }, () => FILTER_SAFE_DIGITS[randomInt(FILTER_SAFE_DIGITS.length)]).join('')}`;

async function postGlobal(client: TestClient, content: string) {
  return client.post('/chat/global', { content });
}

async function globalHistory(client: TestClient) {
  const res = await client.get('/chat/global');
  expect(res.status).toBe(200);
  return MessagesSchema.parse(await res.json());
}

async function postToRoom(client: TestClient, roomId: string, content: string) {
  return client.post(`/chat/rooms/${roomId}/messages`, { content });
}

async function roomHistory(client: TestClient, roomId: string) {
  const res = await client.get(`/chat/rooms/${roomId}/messages`);
  expect(res.status).toBe(200);
  return MessagesSchema.parse(await res.json());
}

async function createPrivateRoom(owner: Chatter, label: string) {
  const res = await owner.client.post('/chat/rooms/private', { name: `${label} ${randomUUID()}` });
  expect(res.status).toBe(200);
  const room = ChatRoomSchema.parse(await res.json());
  return { id: room.id, joinCode: room.joinCode ?? '' };
}

async function joinByCode(player: Chatter, joinCode: string) {
  const res = await player.client.post('/chat/rooms/join', { joinCode });
  expect(res.status).toBe(200);
}

async function privateRoomWith(owner: Chatter, members: Chatter[], label: string) {
  const room = await createPrivateRoom(owner, label);
  for (const member of members) {
    await joinByCode(member, room.joinCode);
  }
  return room;
}

async function messageRows(userId: string) {
  return db()
    .select({ id: chatMessage.id })
    .from(chatMessage)
    .where(eq(chatMessage.userId, userId));
}

async function adminModerate(path: string, body: unknown) {
  const res = await admin.post(`/backoffice/chat/${path}`, body);
  expect(res.status).toBe(200);
}

const GLOBAL_SCOPE = '__global';

describe('player posts to the global chat', () => {
  it('a player posts a message and it appears in the global history for another player', async () => {
    const author = await chatter('gpost');
    const reader = await chatter('gread');
    const content = uniqueText('hello global');

    const res = await postGlobal(author.client, content);

    expect(res.status).toBe(200);
    const sent = ChatMessageSchema.parse(await res.json());
    expect(sent).toMatchObject({
      type: 'user',
      roomId: null,
      userId: author.userId,
      username: author.username,
      content,
      isDeleted: false,
    });
    const seen = (await globalHistory(reader.client)).find((message) => message.id === sent.id);
    expect(seen).toMatchObject({ userId: author.userId, username: author.username, content });
    const rows = await db()
      .select({ roomId: chatMessage.roomId, content: chatMessage.content })
      .from(chatMessage)
      .where(eq(chatMessage.id, sent.id));
    expect(rows).toEqual([{ roomId: null, content }]);
  });

  it('a message containing an @mention of an existing player is stored with the mention resolved', async () => {
    const author = await chatter('mentby');
    const mentioned = await chatter('mentto');
    const stranger = await chatter('mentno');
    const content = `${uniqueText('ping')} @${mentioned.username}`;

    const res = await postGlobal(author.client, content);

    expect(res.status).toBe(200);
    const sent = ChatMessageSchema.parse(await res.json());
    expect(sent.content).toBe(content);
    const notified = async (client: TestClient) => {
      const list = await client.get('/notifications');
      expect(list.status).toBe(200);
      return NotificationsSchema.parse(await list.json()).items.filter(
        (item) => item.type === 'chat.mention',
      );
    };
    await expect
      .poll(() => notified(mentioned.client), { timeout: 10_000 })
      .toEqual([expect.objectContaining({ params: { byUsername: author.username } })]);
    expect(await notified(stranger.client)).toEqual([]);
    expect(await notified(author.client)).toEqual([]);
  });

  it('an unauthenticated caller cannot post to the global chat', async () => {
    const content = uniqueText('anonymous');

    const res = await e2e.app.app.request('/chat/global', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    });

    expect(res.status).toBe(401);
    const rows = await db()
      .select({ id: chatMessage.id })
      .from(chatMessage)
      .where(eq(chatMessage.content, content));
    expect(rows).toEqual([]);
  });

  it('a muted player is refused and no message row is written', async () => {
    const player = await chatter('muted');
    await adminModerate('mutes', {
      userId: player.userId,
      roomId: GLOBAL_SCOPE,
      reason: 'e2e mute',
    });

    const res = await postGlobal(player.client, uniqueText('muted post'));

    expect(res.status).toBe(403);
    expect(RestrictionReasonSchema.parse(await res.json()).data.reason).toBe('muted');
    expect(await messageRows(player.userId)).toEqual([]);
  });

  it('a banned player is refused posting and reading', async () => {
    const player = await chatter('banned');
    await adminModerate('bans', {
      userId: player.userId,
      roomId: GLOBAL_SCOPE,
      reason: 'e2e ban',
    });

    const post = await postGlobal(player.client, uniqueText('banned post'));
    const read = await player.client.get('/chat/global');

    expect(post.status).toBe(403);
    expect(read.status).toBe(403);
    expect(await messageRows(player.userId)).toEqual([]);
  });

  it('a player in cooldown is refused until the cooldown is lifted', async () => {
    const player = await chatter('cooldown');
    expect((await postGlobal(player.client, uniqueText('before cooldown'))).status).toBe(200);
    await adminModerate('cooldowns', {
      userId: player.userId,
      roomId: GLOBAL_SCOPE,
      reason: 'e2e cooldown',
      cooldownSeconds: 3600,
    });

    const refused = await postGlobal(player.client, uniqueText('during cooldown'));

    expect(refused.status).toBe(403);
    const refusal = RestrictionReasonSchema.parse(await refused.json());
    expect(refusal.data.reason).toBe('slow_mode');
    expect(await messageRows(player.userId)).toHaveLength(1);
    await adminModerate('cooldowns/lift', { userId: player.userId, roomId: GLOBAL_SCOPE });
    expect((await postGlobal(player.client, uniqueText('after cooldown'))).status).toBe(200);
    expect(await messageRows(player.userId)).toHaveLength(2);
  });

  it('a message over the length limit or with an invalid attachment is rejected', async () => {
    const player = await chatter('invalid');
    const attachment = {
      kind: 'gif',
      provider: 'e2e',
      externalId: randomUUID(),
      url: 'https://not-allowed.example/a.gif',
      previewUrl: 'https://not-allowed.example/a.png',
      width: 100,
      height: 100,
      title: 'blocked host',
    };

    const tooLong = await postGlobal(player.client, 'x'.repeat(501));
    const atLimit = await postGlobal(player.client, 'y'.repeat(500));
    const badAttachment = await player.client.post('/chat/global', { content: '', attachment });
    const empty = await postGlobal(player.client, '   ');

    expect(tooLong.status).toBe(400);
    expect(badAttachment.status).toBe(400);
    expect(empty.status).toBe(400);
    expect(atLimit.status).toBe(200);
    expect(await messageRows(player.userId)).toHaveLength(1);
  });

  it('a message from a player blocked by the reader is excluded from the reader history', async () => {
    const author = await chatter('hidden');
    const blocker = await chatter('blocker');
    const bystander = await chatter('bystand');
    const content = uniqueText('hidden message');
    const sent = ChatMessageSchema.parse(await (await postGlobal(author.client, content)).json());
    expect((await globalHistory(blocker.client)).map((message) => message.id)).toContain(sent.id);

    expect((await blocker.client.post('/chat/blocks', { blockedId: author.userId })).status).toBe(
      200,
    );

    expect((await globalHistory(blocker.client)).map((message) => message.id)).not.toContain(
      sent.id,
    );
    expect((await globalHistory(bystander.client)).map((message) => message.id)).toContain(sent.id);
  });
});

describe('private rooms and invites', () => {
  it('a player creates a private room and invites another player who joins through the invite', async () => {
    const owner = await chatter('rowner');
    const invitee = await chatter('rinvitee');
    const room = await createPrivateRoom(owner, 'invite flow');

    const invited = await owner.client.post(`/chat/rooms/${room.id}/invites`, {
      userId: invitee.userId,
    });

    expect(invited.status).toBe(200);
    const invite = ChatRoomInviteSchema.parse(await invited.json());
    expect(invite).toMatchObject({
      roomId: room.id,
      inviterId: owner.userId,
      inviteeId: invitee.userId,
      status: 'pending',
    });
    const mine = z
      .array(MyChatRoomInviteSchema)
      .parse(await (await invitee.client.get('/chat/invites')).json());
    expect(mine.map((entry) => entry.id)).toEqual([invite.id]);
    const accepted = await invitee.client.post(`/chat/invites/${invite.id}/accept`);
    expect(accepted.status).toBe(200);
    expect(ChatRoomSchema.parse(await accepted.json()).id).toBe(room.id);
    const content = uniqueText('inside the room');
    expect((await postToRoom(invitee.client, room.id, content)).status).toBe(200);
    expect((await roomHistory(owner.client, room.id)).map((message) => message.content)).toContain(
      content,
    );
    const [stored] = await db()
      .select({ status: chatRoomInvite.status })
      .from(chatRoomInvite)
      .where(eq(chatRoomInvite.id, invite.id));
    expect(stored?.status).toBe('accepted');
  });

  it('a player who was not invited cannot join the private room or read its messages', async () => {
    const owner = await chatter('powner');
    const outsider = await chatter('outsider');
    const room = await createPrivateRoom(owner, 'closed room');
    const secret = uniqueText('members only');
    expect((await postToRoom(owner.client, room.id, secret)).status).toBe(200);

    const read = await outsider.client.get(`/chat/rooms/${room.id}/messages`);
    const post = await postToRoom(outsider.client, room.id, uniqueText('intruder'));
    const publicJoin = await outsider.client.post(`/chat/rooms/${room.id}/join`);
    const wrongCode = await outsider.client.post('/chat/rooms/join', { joinCode: 'ZZZZZZ' });

    expect(read.status).toBe(403);
    expect(post.status).toBe(403);
    expect(publicJoin.status).not.toBe(200);
    expect(wrongCode.status).toBe(404);
    expect(await messageRows(outsider.userId)).toEqual([]);
  });

  it('an expired invite cannot be used to join', async () => {
    const owner = await chatter('eowner');
    const invitee = await chatter('einvitee');
    const room = await createPrivateRoom(owner, 'expiring invite');
    const invite = ChatRoomInviteSchema.parse(
      await (
        await owner.client.post(`/chat/rooms/${room.id}/invites`, { userId: invitee.userId })
      ).json(),
    );
    await db()
      .update(chatRoomInvite)
      .set({ createdAt: sql`now() - interval '8 days'` })
      .where(eq(chatRoomInvite.id, invite.id));

    const accepted = await invitee.client.post(`/chat/invites/${invite.id}/accept`);

    expect(accepted.status).toBe(404);
    const mine = z
      .array(MyChatRoomInviteSchema)
      .parse(await (await invitee.client.get('/chat/invites')).json());
    expect(mine).toEqual([]);
    expect((await invitee.client.get(`/chat/rooms/${room.id}/messages`)).status).toBe(403);
  });

  it('a room ban stops the banned player posting in that room only', async () => {
    const owner = await chatter('bowner');
    const member = await chatter('bmember');
    const banRoom = await privateRoomWith(owner, [member], 'ban room');
    const otherRoom = await privateRoomWith(owner, [member], 'other room');
    expect((await postToRoom(member.client, banRoom.id, uniqueText('before ban'))).status).toBe(
      200,
    );

    const ban = await owner.client.post(`/chat/rooms/${banRoom.id}/ban`, {
      userId: member.userId,
      reason: 'e2e room ban',
    });

    expect(ban.status).toBe(200);
    expect((await postToRoom(member.client, banRoom.id, uniqueText('after ban'))).status).toBe(403);
    expect((await postToRoom(member.client, otherRoom.id, uniqueText('other room'))).status).toBe(
      200,
    );
    expect((await postGlobal(member.client, uniqueText('global still open'))).status).toBe(200);
    const [inBanRoom] = await db()
      .select({ n: sql<number>`count(*)::int` })
      .from(chatMessage)
      .where(and(eq(chatMessage.userId, member.userId), eq(chatMessage.roomId, banRoom.id)));
    expect(inBanRoom?.n).toBe(1);
  });

  it('a room moderator lists moderated rooms and a regular member gets none', async () => {
    const owner = await chatter('mowner');
    const member = await chatter('mmember');
    const room = await privateRoomWith(owner, [member], 'moderated room');

    const ownerRes = await owner.client.get('/chat/rooms/moderated');
    const memberRes = await member.client.get('/chat/rooms/moderated');

    expect(ownerRes.status).toBe(200);
    const ownerRooms = PageOf(ChatRoomSchema).parse(await ownerRes.json());
    expect(ownerRooms.items.map((entry) => entry.id)).toEqual([room.id]);
    expect(ownerRooms.total).toBe(1);
    expect(memberRes.status).toBe(200);
    expect(PageOf(ChatRoomSchema).parse(await memberRes.json())).toMatchObject({
      items: [],
      total: 0,
    });
  });
});

describe('player blocks and ignores', () => {
  it('a player blocks another player and the blocked player messages disappear from the blocker history', async () => {
    const blocker = await chatter('blkr');
    const blocked = await chatter('blkd');
    const friend = await chatter('blkf');
    const room = await privateRoomWith(blocker, [blocked, friend], 'block room');
    const content = uniqueText('from the blocked');
    const sent = ChatMessageSchema.parse(
      await (await postToRoom(blocked.client, room.id, content)).json(),
    );
    expect((await roomHistory(blocker.client, room.id)).map((message) => message.id)).toContain(
      sent.id,
    );

    const res = await blocker.client.post('/chat/blocks', { blockedId: blocked.userId });

    expect(res.status).toBe(200);
    expect((await roomHistory(blocker.client, room.id)).map((message) => message.id)).not.toContain(
      sent.id,
    );
    expect((await roomHistory(friend.client, room.id)).map((message) => message.id)).toContain(
      sent.id,
    );
    const list = BlockedPageSchema.parse(await (await blocker.client.get('/chat/blocks')).json());
    expect(list.items.map((entry) => entry.blockedId)).toEqual([blocked.userId]);
  });

  it('blocking the same player twice does not create a duplicate row', async () => {
    const blocker = await chatter('dblr');
    const blocked = await chatter('dbld');

    const first = await blocker.client.post('/chat/blocks', { blockedId: blocked.userId });
    const second = await blocker.client.post('/chat/blocks', { blockedId: blocked.userId });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const rows = await db()
      .select({ id: chatUserBlock.id })
      .from(chatUserBlock)
      .where(
        and(
          eq(chatUserBlock.blockerId, blocker.userId),
          eq(chatUserBlock.blockedId, blocked.userId),
          isNull(chatUserBlock.removedAt),
        ),
      );
    expect(rows).toHaveLength(1);
    const list = BlockedPageSchema.parse(await (await blocker.client.get('/chat/blocks')).json());
    expect(list.total).toBe(1);
  });

  it('a player cannot list another player blocks', async () => {
    const blocker = await chatter('lblr');
    const blocked = await chatter('lbld');
    const snoop = await chatter('lsnoop');
    expect((await blocker.client.post('/chat/blocks', { blockedId: blocked.userId })).status).toBe(
      200,
    );

    const snoopList = BlockedPageSchema.parse(
      await (await snoop.client.get('/chat/blocks')).json(),
    );
    const blockedList = BlockedPageSchema.parse(
      await (await blocked.client.get('/chat/blocks')).json(),
    );
    const anonymous = await e2e.app.app.request('/chat/blocks');
    const adminRoute = await snoop.client.get('/backoffice/chat/blocks');

    expect(snoopList).toMatchObject({ items: [], total: 0 });
    expect(blockedList).toMatchObject({ items: [], total: 0 });
    expect(anonymous.status).toBe(401);
    expect(adminRoute.status).toBe(403);
  });
});

describe('chat moderation in the backoffice', () => {
  it('an admin with the chat permission mutes a player, lists the mute and lifts it', async () => {
    const player = await chatter('admmute');
    const reason = uniqueText('e2e mute reason');

    await adminModerate('mutes', { userId: player.userId, roomId: GLOBAL_SCOPE, reason });

    const listed = z
      .array(ChatModerationEntrySchema)
      .parse(await (await admin.get(`/backoffice/chat/mutes?userIds=${player.userId}`)).json());
    expect(listed).toEqual([
      expect.objectContaining({ userId: player.userId, scope: GLOBAL_SCOPE, reason }),
    ]);
    expect((await postGlobal(player.client, uniqueText('muted'))).status).toBe(403);
    await adminModerate('mutes/lift', { userId: player.userId, roomId: GLOBAL_SCOPE });
    const after = z
      .array(ChatModerationEntrySchema)
      .parse(await (await admin.get(`/backoffice/chat/mutes?userIds=${player.userId}`)).json());
    expect(after).toEqual([]);
    expect((await postGlobal(player.client, uniqueText('unmuted'))).status).toBe(200);
    const [row] = await db()
      .select({ liftedAt: chatMute.liftedAt })
      .from(chatMute)
      .where(eq(chatMute.userId, player.userId));
    expect(row?.liftedAt).not.toBeNull();
    await flushAudit(e2e.app);
    const audit = await db()
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.resourceId, listed[0]?.id ?? ''));
    expect(audit.map((entry) => entry.action).sort()).toEqual([
      'chat.mute.created',
      'chat.mute.lifted',
    ]);
  });

  it('an admin without the chat permission is refused every moderation route and no row is written', async () => {
    const staff = await newStaff(e2e.app, 'chat-nopermission', 'marketing-banners');
    const target = await chatter('modtarget');
    const body = { userId: target.userId, roomId: GLOBAL_SCOPE, reason: 'should be refused' };
    const lift = { userId: target.userId, roomId: GLOBAL_SCOPE };

    const responses = await Promise.all([
      staff.client.post('/backoffice/chat/mutes', body),
      staff.client.post('/backoffice/chat/mutes/lift', lift),
      staff.client.post('/backoffice/chat/bans', body),
      staff.client.post('/backoffice/chat/bans/lift', lift),
      staff.client.post('/backoffice/chat/cooldowns', { ...body, cooldownSeconds: 60 }),
      staff.client.post('/backoffice/chat/cooldowns/lift', lift),
      staff.client.get('/backoffice/chat/mutes'),
      staff.client.get('/backoffice/chat/bans'),
      staff.client.get('/backoffice/chat/cooldowns'),
      staff.client.get('/backoffice/chat/messages'),
      target.client.post('/backoffice/chat/mutes', body),
    ]);

    expect(responses.map((res) => res.status)).toEqual(responses.map(() => 403));
    const [mutes, bans, cooldowns] = await Promise.all([
      db().select({ id: chatMute.id }).from(chatMute).where(eq(chatMute.userId, target.userId)),
      db()
        .select({ id: chatPlatformBan.id })
        .from(chatPlatformBan)
        .where(eq(chatPlatformBan.userId, target.userId)),
      db()
        .select({ id: chatPlayerCooldown.id })
        .from(chatPlayerCooldown)
        .where(eq(chatPlayerCooldown.userId, target.userId)),
    ]);
    expect([mutes, bans, cooldowns]).toEqual([[], [], []]);
    expect((await postGlobal(target.client, uniqueText('still free'))).status).toBe(200);
  });

  it('an admin ban writes an audit row and lifting it restores posting', async () => {
    const player = await chatter('admban');
    await adminModerate('bans', {
      userId: player.userId,
      roomId: GLOBAL_SCOPE,
      reason: 'e2e audited ban',
    });
    expect((await postGlobal(player.client, uniqueText('banned'))).status).toBe(403);
    const [ban] = await db()
      .select({ id: chatPlatformBan.id })
      .from(chatPlatformBan)
      .where(eq(chatPlatformBan.userId, player.userId));

    await adminModerate('bans/lift', { userId: player.userId, roomId: GLOBAL_SCOPE });

    expect((await postGlobal(player.client, uniqueText('restored'))).status).toBe(200);
    expect((await player.client.get('/chat/global')).status).toBe(200);
    await flushAudit(e2e.app);
    const audit = await db()
      .select({ action: auditLog.action, actorType: auditLog.actorType })
      .from(auditLog)
      .where(eq(auditLog.resourceId, ban?.id ?? ''));
    expect([...audit].sort((a, b) => a.action.localeCompare(b.action))).toEqual([
      { action: 'chat.platform_ban.created', actorType: 'admin' },
      { action: 'chat.platform_ban.lifted', actorType: 'admin' },
    ]);
  });

  it('an admin cooldown is applied and lifted and the player posting follows it', async () => {
    const player = await chatter('admcool');
    expect((await postGlobal(player.client, uniqueText('first'))).status).toBe(200);

    await adminModerate('cooldowns', {
      userId: player.userId,
      roomId: GLOBAL_SCOPE,
      reason: 'e2e cooldown',
      cooldownSeconds: 3600,
    });

    const listed = await admin.get(`/backoffice/chat/cooldowns?userIds=${player.userId}`);
    expect(
      z
        .array(ChatModerationEntrySchema.extend({ cooldownSeconds: z.number() }))
        .parse(await listed.json()),
    ).toEqual([
      expect.objectContaining({
        userId: player.userId,
        scope: GLOBAL_SCOPE,
        cooldownSeconds: 3600,
      }),
    ]);
    expect((await postGlobal(player.client, uniqueText('second'))).status).toBe(403);
    await adminModerate('cooldowns/lift', { userId: player.userId, roomId: GLOBAL_SCOPE });
    const afterLift = await admin.get(`/backoffice/chat/cooldowns?userIds=${player.userId}`);
    expect(await afterLift.json()).toEqual([]);
    expect((await postGlobal(player.client, uniqueText('third'))).status).toBe(200);
    await flushAudit(e2e.app);
    const audit = await db()
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actorType, 'admin'),
          sql`${auditLog.action} in ('chat.cooldown.created', 'chat.cooldown.lifted')`,
          sql`${auditLog.after}->>'userId' = ${player.userId}`,
        ),
      );
    expect(audit.map((entry) => entry.action).sort()).toEqual([
      'chat.cooldown.created',
      'chat.cooldown.lifted',
    ]);
  });

  it('an admin lists messages filtered by player and by room', async () => {
    const author = await chatter('lstauth');
    const other = await chatter('lstoth');
    const room = await privateRoomWith(author, [other], 'listing room');
    const globalText = uniqueText('listed global');
    const roomText = uniqueText('listed room');
    const otherText = uniqueText('listed other');
    await postGlobal(author.client, globalText);
    await postToRoom(author.client, room.id, roomText);
    await postGlobal(other.client, otherText);
    const contentsOf = async (path: string) => {
      const res = await admin.get(path);
      expect(res.status).toBe(200);
      return PageOf(AdminChatMessageSchema)
        .parse(await res.json())
        .items.map((m) => m.content);
    };

    const byPlayer = await contentsOf(`/backoffice/chat/messages?playerId=${author.playerId}`);
    const bySender = await contentsOf(`/backoffice/chat/messages?senderId=${author.userId}`);
    const byRoom = await contentsOf(`/backoffice/chat/messages?roomId=${room.id}`);
    const byGlobal = await contentsOf(
      `/backoffice/chat/messages?roomId=__global&senderId=${author.userId}`,
    );

    expect([...byPlayer].sort()).toEqual([globalText, roomText].sort());
    expect([...bySender].sort()).toEqual([globalText, roomText].sort());
    expect(byRoom).toEqual([roomText]);
    expect(byGlobal).toEqual([globalText]);
    expect(byPlayer).not.toContain(otherText);
  });
});
