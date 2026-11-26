import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as z from 'zod';
import { CHAT_TRANSFER_CHECK } from '@openora/core/contracts';
import { DRIZZLE } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import {
  ChatCommandDescriptorSchema,
  type ChatCommandType as ChatCommandKey,
} from '@openora/core/engagement/contracts/chat-commands';
import { chatRoom, chatRoomBan } from '@openora/core/engagement/schema/chat';
import { chatCommandConfig } from '@openora/core/engagement/schema/chat-commands';
import {
  asAdmin,
  bootE2e,
  closeE2e,
  flushAudit,
  newPlayer,
  newStaff,
  registerAndMaterializePlayer,
  type E2e,
  type TestClient,
} from '../index.js';

let e2e: E2e;
let admin: TestClient;

beforeAll(async () => {
  e2e = await bootE2e();
  admin = await asAdmin(e2e.app.app);
}, 60_000);

afterAll(() => closeE2e(e2e));

const db = () => e2e.app.container.get(DRIZZLE).db;
const CommandsSchema = z.array(ChatCommandDescriptorSchema);
const AdminCommandsSchema = z.object({ items: CommandsSchema, total: z.number() });
const MentionsSchema = z.array(z.object({ userId: z.string(), username: z.string() }));

async function listCommands(client: TestClient) {
  const res = await client.get('/chat-command/commands');
  expect(res.status).toBe(200);
  return CommandsSchema.parse(await res.json());
}

async function adminListCommands() {
  const res = await admin.get('/backoffice/chat-command/commands?limit=100');
  expect(res.status).toBe(200);
  return AdminCommandsSchema.parse(await res.json()).items;
}

async function updateCommand(
  client: TestClient,
  key: string,
  body: { enabled: boolean; config?: unknown },
) {
  return client.patch(`/backoffice/chat-command/commands/${key}`, body);
}

async function seedCommand(key: ChatCommandKey, enabled: boolean) {
  await db()
    .insert(chatCommandConfig)
    .values({ key, enabled, label: key.charAt(0).toUpperCase() + key.slice(1) });
}

async function removeCommand(key: string) {
  await db().delete(chatCommandConfig).where(eq(chatCommandConfig.key, key));
}

async function playerNamed(username: string) {
  const account = await registerAndMaterializePlayer(e2e.app, {
    email: `${username}@e2e.test`,
    username,
  });
  return { ...account, username };
}

const searchMentions = (client: TestClient, q: string) =>
  client.get(`/chat-command/mention-search?q=${encodeURIComponent(q)}&roomId=__global`);

describe('chat command registry', () => {
  it('a player lists only enabled commands', async () => {
    const player = await newPlayer(e2e.app, 'cmd-list');
    await seedCommand('mention', true);
    await seedCommand('profile', true);
    try {
      expect((await updateCommand(admin, 'profile', { enabled: false })).status).toBe(200);

      const commands = await listCommands(player.client);

      const keys = commands.map((command) => command.key);
      expect(keys).toContain('mention');
      expect(keys).not.toContain('profile');
      expect(commands.every((command) => command.enabled)).toBe(true);
    } finally {
      await removeCommand('mention');
      await removeCommand('profile');
    }
  });

  it('an admin lists every command including disabled ones', async () => {
    await seedCommand('ignore', true);
    await seedCommand('unignore', true);
    try {
      expect((await updateCommand(admin, 'unignore', { enabled: false })).status).toBe(200);

      const commands = await adminListCommands();

      expect(commands.find((command) => command.key === 'unignore')?.enabled).toBe(false);
      expect(commands.find((command) => command.key === 'ignore')?.enabled).toBe(true);
    } finally {
      await removeCommand('ignore');
      await removeCommand('unignore');
    }
  });

  it('an admin updates a command enabled flag and limits and an audit row is written', async () => {
    const config = {
      minAmount: { currency: 'USD', amount: '2.00000000' },
      maxAmount: { currency: 'USD', amount: '500.00000000' },
      maxRecipients: 7,
    };
    try {
      const res = await updateCommand(admin, 'donate', { enabled: false, config });

      expect(res.status).toBe(200);
      const updated = ChatCommandDescriptorSchema.parse(await res.json());
      expect(updated).toMatchObject({ key: 'donate', enabled: false, label: 'Donate', config });
      const [stored] = await db()
        .select({ enabled: chatCommandConfig.enabled, config: chatCommandConfig.config })
        .from(chatCommandConfig)
        .where(eq(chatCommandConfig.key, 'donate'));
      expect(stored).toEqual({ enabled: false, config });
      await flushAudit(e2e.app);
      const audit = await db()
        .select({ after: auditLog.after, actorType: auditLog.actorType })
        .from(auditLog)
        .where(and(eq(auditLog.action, 'chat.command.updated'), eq(auditLog.resourceId, 'donate')));
      expect(audit).toHaveLength(1);
      expect(audit[0]).toEqual({ actorType: 'admin', after: { enabled: false, config } });
    } finally {
      await removeCommand('donate');
    }
  });

  it('an admin updating a command with a non positive or malformed limit is rejected', async () => {
    await seedCommand('rain', true);
    const bodies = [
      { enabled: true, config: { maxRecipients: 0 } },
      { enabled: true, config: { maxRecipients: -3 } },
      { enabled: true, config: { maxRecipients: 1.5 } },
      { enabled: true, config: { maxAmount: { currency: 'USD', amount: '-5' } } },
      { enabled: true, config: { minAmount: { currency: 'USD', amount: 'abc' } } },
    ];

    try {
      for (const body of bodies) {
        const res = await updateCommand(admin, 'rain', body);
        expect(res.status).toBe(400);
      }

      const commands = await adminListCommands();
      expect(commands.find((command) => command.key === 'rain')).toMatchObject({
        enabled: true,
        config: null,
      });
    } finally {
      await removeCommand('rain');
    }
  });

  it('an admin without the chat-command permission cannot update a command', async () => {
    const staff = await newStaff(e2e.app, 'cmd-nopermission', 'marketing-banners');
    const player = await newPlayer(e2e.app, 'cmd-player');
    await seedCommand('gift', true);

    const staffRes = await updateCommand(staff.client, 'gift', { enabled: false });
    const playerRes = await updateCommand(player.client, 'gift', { enabled: false });
    const staffList = await staff.client.get('/backoffice/chat-command/commands');

    expect(staffRes.status).toBe(403);
    expect(playerRes.status).toBe(403);
    expect(staffList.status).toBe(403);
    try {
      const commands = await adminListCommands();
      expect(commands.find((command) => command.key === 'gift')?.enabled).toBe(true);
    } finally {
      await removeCommand('gift');
    }
  });

  it('an unauthenticated caller lists only enabled commands', async () => {
    await seedCommand('mention', true);
    await seedCommand('profile', false);
    try {
      const res = await e2e.app.app.request('/chat-command/commands');

      expect(res.status).toBe(200);
      const commands = CommandsSchema.parse(await res.json());
      const keys = commands.map((command) => command.key);
      expect(keys).toContain('mention');
      expect(keys).not.toContain('profile');
    } finally {
      await removeCommand('mention');
      await removeCommand('profile');
    }
  });

  it('a transfer from a player banned in the room is refused and an unbanned one is allowed', async () => {
    const slug = `ban-room-${randomInt(10 ** 8, 10 ** 9)}`;
    const [room] = await db()
      .insert(chatRoom)
      .values({ name: slug, slug, isPublic: true })
      .returning({ id: chatRoom.id });
    if (!room) {
      throw new Error('room not created');
    }
    const banned = await newPlayer(e2e.app, 'transfer-banned');
    const bystander = await newPlayer(e2e.app, 'transfer-bystander');
    await seedCommand('gift', true);
    await db()
      .insert(chatRoomBan)
      .values({ roomId: room.id, userId: banned.userId, bannedBy: bystander.userId });
    const transferCheck = e2e.app.container.get(CHAT_TRANSFER_CHECK);
    const check = (actorId: string) =>
      db().transaction((tx) =>
        transferCheck.check(tx, { actorId, roomId: room.id, counterpartIds: [], command: 'gift' }),
      );
    try {
      const refused = await check(banned.userId);
      const allowed = await check(bystander.userId);

      expect(refused).toEqual({ allowed: false, refusal: 'room_access_denied' });
      expect(allowed).toMatchObject({ allowed: true });
    } finally {
      await removeCommand('gift');
      await db().delete(chatRoom).where(eq(chatRoom.id, room.id));
    }
  });
});

describe('mention search', () => {
  it('a player searches by username prefix and gets matching players', async () => {
    const tag = `mn${randomInt(10 ** 8, 10 ** 9)}`;
    const searcher = await newPlayer(e2e.app, 'mention-searcher');
    const alpha = await playerNamed(`${tag}a`);
    const bravo = await playerNamed(`${tag}b`);
    const other = await playerNamed(`zz${randomInt(10 ** 8, 10 ** 9)}`);

    const res = await searchMentions(searcher.client, tag);

    expect(res.status).toBe(200);
    const found = MentionsSchema.parse(await res.json());
    expect([...found].sort((a, b) => a.username.localeCompare(b.username))).toEqual([
      { userId: alpha.userId, username: alpha.username },
      { userId: bravo.userId, username: bravo.username },
    ]);
    expect(found.map((entry) => entry.userId)).not.toContain(other.userId);
    expect(found.map((entry) => entry.userId)).not.toContain(searcher.userId);
  });

  it('players the caller blocked or ignored are excluded from the results', async () => {
    const tag = `mb${randomInt(10 ** 8, 10 ** 9)}`;
    const searcher = await newPlayer(e2e.app, 'mention-blocker');
    const blocked = await playerNamed(`${tag}x`);
    const ignored = await playerNamed(`${tag}y`);
    const visible = await playerNamed(`${tag}z`);
    expect((await searcher.client.post('/chat/blocks', { blockedId: blocked.userId })).status).toBe(
      200,
    );
    expect(
      (await searcher.client.post('/chat/ignores', { ignoredId: ignored.userId })).status,
    ).toBe(200);

    const res = await searchMentions(searcher.client, tag);

    expect(res.status).toBe(200);
    expect(MentionsSchema.parse(await res.json())).toEqual([
      { userId: visible.userId, username: visible.username },
    ]);
  });

  it.todo(
    'BUG: a player who blocked the caller is excluded from the results (chat.service.ts:591 and chat-commands.service.ts:159 exclude only the caller own blocks and ignores)',
  );

  it('an unauthenticated caller cannot search mentions', async () => {
    const res = await e2e.app.app.request('/chat-command/mention-search?q=abc&roomId=__global');

    expect(res.status).toBe(401);
  });
});
