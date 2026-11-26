import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as z from 'zod';
import { DRIZZLE } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import { player } from '@openora/core/pam/schema/profile';
import { PlayerNoteSchema } from '@openora/core/pam/contracts/player-note';
import { AccountManagerSchema, PlayerSchema, type PlayerStatus } from '@openora/core/contracts';
import { paginated } from '@openora/core/contracts/kit';
import {
  asAdmin,
  bootE2e,
  closeE2e,
  flushAudit,
  newPlayer,
  newStaff,
  uniqueUsername,
  verifyKyc,
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

const PlayerWithTagsSchema = PlayerSchema.extend({
  tags: z.array(z.string()),
  accountManager: AccountManagerSchema.nullable(),
});
const PlayerPageSchema = paginated(PlayerWithTagsSchema);
const NotePageSchema = paginated(PlayerNoteSchema);
const AssignedManagersSchema = z.array(AccountManagerSchema.extend({ email: z.string() }));
const SearchResultsSchema = z.array(z.object({ userId: z.string(), username: z.string() }));
const RegistrationPointsSchema = z.array(z.object({ date: z.string(), count: z.number() }));
const ManagerResultSchema = z.object({ accountManager: AccountManagerSchema.nullable() });

const shortId = () => randomUUID().replaceAll('-', '').slice(0, 10);

async function bodyOf(res: Response): Promise<unknown> {
  return res.json();
}

async function errorOf(res: Response) {
  return ErrorBodySchema.parse(await bodyOf(res));
}

async function fetchPlayer(playerId: string) {
  const res = await admin.get(`/players/${playerId}`);
  expect(res.status).toBe(200);
  return PlayerWithTagsSchema.parse(await bodyOf(res));
}

async function listPlayers(query: Record<string, string>) {
  const res = await admin.get(`/players?${new URLSearchParams(query).toString()}`);
  expect(res.status).toBe(200);
  return PlayerPageSchema.parse(await bodyOf(res));
}

async function setStatus(playerId: string, status: PlayerStatus) {
  const res = await admin.patch(`/players/${playerId}`, { status });
  expect(res.status).toBe(200);
}

async function auditRows(action: string, resourceId: string) {
  await flushAudit(e2e.app);
  return db()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.resourceId, resourceId)));
}

const newOperator = (prefix: string) => newStaff(e2e.app, prefix, 'admin');
const newReadOnlyOperator = (prefix: string) => newStaff(e2e.app, prefix, 'casino-manager');
const newOperatorWithoutPlayerAccess = (prefix: string) =>
  newStaff(e2e.app, prefix, 'marketing-banners');

describe('player directory', () => {
  it('an admin lists players with pagination, search and filters', async () => {
    const tag = `pmlist${shortId()}`;
    const first = await newPlayer(e2e.app, tag);
    const second = await newPlayer(e2e.app, tag);
    const third = await newPlayer(e2e.app, tag);
    const bystander = await newPlayer(e2e.app, `pmother${shortId()}`);
    const ids = [first.playerId, second.playerId, third.playerId];

    const pageOne = await listPlayers({ search: tag, limit: '2', page: '1', sortOrder: 'asc' });
    const pageTwo = await listPlayers({ search: tag, limit: '2', page: '2', sortOrder: 'asc' });

    expect(pageOne.total).toBe(3);
    expect(pageOne.items).toHaveLength(2);
    expect(pageTwo.items).toHaveLength(1);
    expect([...pageOne.items, ...pageTwo.items].map((p) => p.id).sort()).toEqual([...ids].sort());
    expect(pageOne.items.map((p) => p.id)).not.toContain(bystander.playerId);

    await setStatus(third.playerId, 'suspended');
    await verifyKyc(admin, second.userId);
    const suspended = await listPlayers({ search: tag, status: 'suspended' });
    const overridden = await listPlayers({ search: tag, kycStatus: 'manually_overridden' });
    const active = await listPlayers({ search: tag, status: 'active' });

    expect(suspended.items.map((p) => p.id)).toEqual([third.playerId]);
    expect(suspended.total).toBe(1);
    expect(overridden.items.map((p) => p.id)).toEqual([second.playerId]);
    expect(active.items.map((p) => p.id).sort()).toEqual([first.playerId, second.playerId].sort());
  });

  it('an admin fetches a player by id and by user id', async () => {
    const target = await newPlayer(e2e.app, `pmget${shortId()}`);

    const byId = await admin.get(`/players/${target.playerId}`);
    const byUser = await admin.get(`/players/by-user/${target.userId}`);

    expect(byId.status).toBe(200);
    expect(byUser.status).toBe(200);
    const fromId = PlayerWithTagsSchema.parse(await bodyOf(byId));
    const fromUser = PlayerSchema.parse(await bodyOf(byUser));
    expect(fromId).toEqual(
      expect.objectContaining({
        id: target.playerId,
        userId: target.userId,
        email: target.email,
        status: 'active',
      }),
    );
    expect(fromUser).toEqual(
      expect.objectContaining({ id: target.playerId, userId: target.userId, email: target.email }),
    );
  });

  it('fetching an unknown player returns not found', async () => {
    const byId = await admin.get(`/players/${randomUUID()}`);
    const byUser = await admin.get(`/players/by-user/${randomUUID()}`);

    expect(byId.status).toBe(404);
    expect(byUser.status).toBe(404);
    expect((await errorOf(byId)).code).toBe('NOT_FOUND');
  });

  it('the search route matches by email and username', async () => {
    const tag = `pmfind${shortId()}`;
    const target = await newPlayer(e2e.app, tag);
    const searcher = await newPlayer(e2e.app, `pmsearcher${shortId()}`);
    const username = (await fetchPlayer(target.playerId)).username;

    const byEmail = await searcher.client.get(`/players/search?q=${encodeURIComponent(tag)}`);
    const byUsername = await searcher.client.get(
      `/players/search?q=${encodeURIComponent(username)}`,
    );
    const unrelated = await searcher.client.get(`/players/search?q=nomatch${shortId()}`);

    expect(byEmail.status).toBe(200);
    expect(byUsername.status).toBe(200);
    expect(SearchResultsSchema.parse(await bodyOf(byEmail))).toEqual([
      expect.objectContaining({ userId: target.userId, username }),
    ]);
    expect(SearchResultsSchema.parse(await bodyOf(byUsername)).map((r) => r.userId)).toContain(
      target.userId,
    );
    expect(SearchResultsSchema.parse(await bodyOf(unrelated))).toEqual([]);
  });

  it.todo('the search route matches by phone');

  it('registration stats count the players registered in the window', async () => {
    const total = async () => {
      const res = await admin.get('/players/stats/registrations?days=2');
      expect(res.status).toBe(200);
      const points = RegistrationPointsSchema.parse(await bodyOf(res));
      expect(points).toHaveLength(2);
      return points.reduce((sum, point) => sum + point.count, 0);
    };
    const before = await total();

    await newPlayer(e2e.app, `pmstats${shortId()}`);
    await newPlayer(e2e.app, `pmstats${shortId()}`);

    expect(await total()).toBe(before + 2);
  });

  it('an admin without the permission is refused with forbidden', async () => {
    const target = await newPlayer(e2e.app, `pmforbid${shortId()}`);
    const outsider = await newOperatorWithoutPlayerAccess('pm-outsider');
    const viewer = await newReadOnlyOperator('pm-viewer');

    const list = await outsider.client.get('/players');
    const get = await outsider.client.get(`/players/${target.playerId}`);
    const update = await viewer.client.patch(`/players/${target.playerId}`, {
      status: 'suspended',
    });
    const permitted = await viewer.client.get(`/players/${target.playerId}`);

    expect(list.status).toBe(403);
    expect(get.status).toBe(403);
    expect(update.status).toBe(403);
    expect((await errorOf(update)).code).toBe('FORBIDDEN');
    expect(permitted.status).toBe(200);
    expect((await fetchPlayer(target.playerId)).status).toBe('active');
  });

  it('a player cannot call the player directory routes', async () => {
    const caller = await newPlayer(e2e.app, `pmcaller${shortId()}`);
    const victim = await newPlayer(e2e.app, `pmvictim${shortId()}`);

    const responses = await Promise.all([
      caller.client.get('/players'),
      caller.client.get(`/players/${victim.playerId}`),
      caller.client.get(`/players/by-user/${victim.userId}`),
      caller.client.patch(`/players/${victim.playerId}`, { status: 'suspended' }),
      caller.client.del(`/players/${victim.playerId}`),
      caller.client.get('/players/stats/summary'),
      caller.client.get('/players/stats/registrations'),
    ]);

    expect(responses.map((res) => res.status)).toEqual([403, 403, 403, 403, 403, 403, 403]);
    expect((await fetchPlayer(victim.playerId)).status).toBe('active');
  });
});

describe('player update', () => {
  it('an admin updates player details and the change is audited with before and after', async () => {
    const operator = await newOperator('pm-updater');
    const target = await newPlayer(e2e.app, `pmupdate${shortId()}`);
    const before = await fetchPlayer(target.playerId);

    const res = await operator.client.patch(`/players/${target.playerId}`, {
      status: 'suspended',
      level: 7,
    });

    expect(res.status).toBe(200);
    expect(PlayerWithTagsSchema.parse(await bodyOf(res))).toEqual(
      expect.objectContaining({ status: 'suspended', level: 7 }),
    );
    expect(await fetchPlayer(target.playerId)).toEqual(
      expect.objectContaining({ status: 'suspended', level: 7 }),
    );
    const [row] = await auditRows('admin.player.updated', target.playerId);
    expect(row).toEqual(
      expect.objectContaining({
        actorId: operator.userId,
        actorType: 'admin',
        resourceType: 'player',
        before: { username: before.username, status: 'active', level: before.level },
        after: { username: before.username, status: 'suspended', level: 7 },
      }),
    );
    const statusChanges = await auditRows('player.status.changed', target.playerId);
    expect(statusChanges.map((r) => r.actorId)).toEqual([operator.userId]);
  });

  it('a suspended player live session is refused and identity me returns no account', async () => {
    const target = await newPlayer(e2e.app, `pmsuspend${shortId()}`);
    const meBefore = await target.client.get('/identity/me');
    expect(z.object({ id: z.string() }).parse(await bodyOf(meBefore)).id).toBe(target.userId);
    expect((await target.client.get('/profile')).status).toBe(200);

    await setStatus(target.playerId, 'suspended');

    const profile = await target.client.get('/profile');
    const balances = await target.client.get('/wallet/balances');
    const me = await target.client.get('/identity/me');
    expect(profile.status).toBe(401);
    expect(balances.status).toBe(401);
    expect(me.status).toBe(200);
    expect(await bodyOf(me)).toBeNull();
    const login = await e2e.app.app.request('/identity/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: target.email, password: 'password1234' }),
    });
    expect(login.status).toBe(403);
  });

  it('an admin cannot set an invalid status, level or username', async () => {
    const target = await newPlayer(e2e.app, `pminvalid${shortId()}`);
    const before = await fetchPlayer(target.playerId);

    const badStatus = await admin.patch(`/players/${target.playerId}`, { status: 'banned' });
    const badLevel = await admin.patch(`/players/${target.playerId}`, { level: 101 });
    const badUsername = await admin.patch(`/players/${target.playerId}`, { username: 'x' });

    expect([badStatus.status, badLevel.status, badUsername.status]).toEqual([400, 400, 400]);
    const after = await fetchPlayer(target.playerId);
    expect(after.status).toBe(before.status);
    expect(after.level).toBe(before.level);
    expect(after.username).toBe(before.username);
  });

  it.todo('an admin cannot set an invalid country or language');

  it('a player cannot update another player through the admin route', async () => {
    const attacker = await newPlayer(e2e.app, `pmattacker${shortId()}`);
    const victim = await newPlayer(e2e.app, `pmtarget${shortId()}`);
    const before = await fetchPlayer(victim.playerId);

    const res = await attacker.client.patch(`/players/${victim.playerId}`, {
      status: 'closed',
      level: 100,
      username: uniqueUsername('hijack'),
    });

    expect(res.status).toBe(403);
    expect(await fetchPlayer(victim.playerId)).toEqual(before);
    expect(await auditRows('admin.player.updated', victim.playerId)).toEqual([]);
  });
});

describe('account managers', () => {
  it('an admin assigns an account manager to a player and the assignment is listed', async () => {
    const manager = await newOperator('pm-manager');
    const target = await newPlayer(e2e.app, `pmassign${shortId()}`);

    const res = await admin.put(`/players/${target.playerId}/account-manager`, {
      accountManagerId: manager.userId,
    });

    expect(res.status).toBe(200);
    expect(ManagerResultSchema.parse(await bodyOf(res)).accountManager).toEqual({
      userId: manager.userId,
      name: manager.name,
      isActive: true,
    });
    expect((await fetchPlayer(target.playerId)).accountManager?.userId).toBe(manager.userId);
    const assigned = await admin.get('/players/account-managers/assigned');
    expect(AssignedManagersSchema.parse(await bodyOf(assigned))).toContainEqual(
      expect.objectContaining({ userId: manager.userId, email: manager.email }),
    );
    const [row] = await auditRows('admin.player.account_manager_changed', target.playerId);
    expect(row).toEqual(
      expect.objectContaining({
        before: { accountManagerId: null },
        after: { accountManagerId: manager.userId },
      }),
    );
  });

  it('assigning a non admin as account manager is refused', async () => {
    const target = await newPlayer(e2e.app, `pmbadmgr${shortId()}`);
    const otherPlayer = await newPlayer(e2e.app, `pmnotstaff${shortId()}`);
    const noPlayerAccess = await newOperatorWithoutPlayerAccess('pm-noaccess');

    const asPlayerAccount = await admin.put(`/players/${target.playerId}/account-manager`, {
      accountManagerId: otherPlayer.userId,
    });
    const withoutGrant = await admin.put(`/players/${target.playerId}/account-manager`, {
      accountManagerId: noPlayerAccess.userId,
    });
    const unknown = await admin.put(`/players/${target.playerId}/account-manager`, {
      accountManagerId: randomUUID(),
    });

    expect(asPlayerAccount.status).toBe(422);
    expect((await errorOf(asPlayerAccount)).data).toEqual({ reason: 'not_eligible' });
    expect(withoutGrant.status).toBe(422);
    expect((await errorOf(withoutGrant)).data).toEqual({ reason: 'not_eligible' });
    expect(unknown.status).toBe(422);
    expect((await errorOf(unknown)).data).toEqual({ reason: 'unknown' });
    expect((await fetchPlayer(target.playerId)).accountManager).toBeNull();
    expect(await auditRows('admin.player.account_manager_changed', target.playerId)).toEqual([]);
  });

  it('clearing the account manager removes the assignment', async () => {
    const manager = await newOperator('pm-clearmgr');
    const target = await newPlayer(e2e.app, `pmclear${shortId()}`);
    await admin.put(`/players/${target.playerId}/account-manager`, {
      accountManagerId: manager.userId,
    });
    expect((await fetchPlayer(target.playerId)).accountManager?.userId).toBe(manager.userId);

    const res = await admin.put(`/players/${target.playerId}/account-manager`, {
      accountManagerId: null,
    });

    expect(res.status).toBe(200);
    expect(ManagerResultSchema.parse(await bodyOf(res)).accountManager).toBeNull();
    expect((await fetchPlayer(target.playerId)).accountManager).toBeNull();
    const [stored] = await db()
      .select({ accountManagerId: player.accountManagerId })
      .from(player)
      .where(eq(player.id, target.playerId));
    expect(stored?.accountManagerId).toBeNull();
    const assigned = AssignedManagersSchema.parse(
      await bodyOf(await admin.get('/players/account-managers/assigned')),
    );
    expect(assigned.map((m) => m.userId)).not.toContain(manager.userId);
  });

  it('the player list filtered by an account manager returns only the players of that manager', async () => {
    const manager = await newOperator('pm-ownmgr');
    const other = await newOperator('pm-othermgr');
    const tag = `pmmgr${shortId()}`;
    const managed = await newPlayer(e2e.app, tag);
    const alsoManaged = await newPlayer(e2e.app, tag);
    const otherManaged = await newPlayer(e2e.app, tag);
    await newPlayer(e2e.app, tag);
    for (const [target, owner] of [
      [managed, manager],
      [alsoManaged, manager],
      [otherManaged, other],
    ] as const) {
      const res = await admin.put(`/players/${target.playerId}/account-manager`, {
        accountManagerId: owner.userId,
      });
      expect(res.status).toBe(200);
    }

    const filtered = await listPlayers({ search: tag, accountManagerId: manager.userId });

    expect(filtered.items.map((p) => p.id).sort()).toEqual(
      [managed.playerId, alsoManaged.playerId].sort(),
    );
    expect(filtered.total).toBe(2);
    const assigned = AssignedManagersSchema.parse(
      await bodyOf(await admin.get('/players/account-managers/assigned')),
    );
    expect(assigned.map((m) => m.userId)).toEqual(
      expect.arrayContaining([manager.userId, other.userId]),
    );
  });
});

describe('player notes', () => {
  const notePath = (playerId: string) => `/player/${playerId}/note`;

  async function listNotes(client: TestClient, playerId: string) {
    const res = await client.get(notePath(playerId));
    expect(res.status).toBe(200);
    return NotePageSchema.parse(await bodyOf(res));
  }

  it('an admin adds a note to a player and it is listed newest first', async () => {
    const operator = await newOperator('pm-noter');
    const target = await newPlayer(e2e.app, `pmnote${shortId()}`);

    const first = await operator.client.post(notePath(target.playerId), { content: 'first note' });
    const second = await operator.client.post(notePath(target.playerId), {
      content: 'second note',
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const listed = await listNotes(operator.client, target.playerId);
    expect(listed.total).toBe(2);
    expect(listed.items.map((n) => n.content)).toEqual(['second note', 'first note']);
    const [row] = await auditRows('admin.player_note.created', target.playerId);
    expect(row).toEqual(expect.objectContaining({ actorId: operator.userId, actorType: 'admin' }));
  });

  it('a note with empty or oversized content is refused', async () => {
    const target = await newPlayer(e2e.app, `pmnotebad${shortId()}`);

    const empty = await admin.post(notePath(target.playerId), { content: '' });
    const oversized = await admin.post(notePath(target.playerId), { content: 'x'.repeat(5001) });
    const atLimit = await admin.post(notePath(target.playerId), { content: 'x'.repeat(5000) });

    expect(empty.status).toBe(400);
    expect(oversized.status).toBe(400);
    expect(atLimit.status).toBe(200);
    expect((await listNotes(admin, target.playerId)).total).toBe(1);
  });

  it('notes of one player are not listed for another player', async () => {
    const noted = await newPlayer(e2e.app, `pmnoted${shortId()}`);
    const clean = await newPlayer(e2e.app, `pmclean${shortId()}`);
    const content = `private ${shortId()}`;
    await admin.post(notePath(noted.playerId), { content });

    const other = await listNotes(admin, clean.playerId);
    const own = await listNotes(admin, noted.playerId);

    expect(other.items).toEqual([]);
    expect(other.total).toBe(0);
    expect(own.items.map((n) => n.content)).toEqual([content]);
  });

  it.todo('a note on an unknown player returns not found');

  it('an admin without the permission cannot read or add notes', async () => {
    const target = await newPlayer(e2e.app, `pmnoperm${shortId()}`);
    const outsider = await newOperatorWithoutPlayerAccess('pm-nonotes');

    const read = await outsider.client.get(notePath(target.playerId));
    const write = await outsider.client.post(notePath(target.playerId), { content: 'sneaky' });

    expect(read.status).toBe(403);
    expect(write.status).toBe(403);
    expect((await listNotes(admin, target.playerId)).total).toBe(0);
    expect(await auditRows('admin.player_note.created', target.playerId)).toEqual([]);
  });

  it('a player cannot read the notes about themselves', async () => {
    const target = await newPlayer(e2e.app, `pmselfnote${shortId()}`);
    const content = `internal ${shortId()}`;
    await admin.post(notePath(target.playerId), { content });

    const read = await target.client.get(notePath(target.playerId));
    const write = await target.client.post(notePath(target.playerId), { content: 'self note' });

    expect(read.status).toBe(403);
    expect(await read.text()).not.toContain(content);
    expect(write.status).toBe(403);
    expect((await listNotes(admin, target.playerId)).total).toBe(1);
  });

  it('a note records its author and creation time and cannot be edited through the API', async () => {
    const operator = await newOperator('pm-author');
    const target = await newPlayer(e2e.app, `pmimmutable${shortId()}`);
    const startedAt = Date.now();
    const created = await operator.client.post(notePath(target.playerId), { content: 'original' });
    const note = PlayerNoteSchema.parse(await bodyOf(created));

    const edits = await Promise.all([
      operator.client.patch(`${notePath(target.playerId)}/${note.id}`, { content: 'edited' }),
      operator.client.put(`${notePath(target.playerId)}/${note.id}`, { content: 'edited' }),
      operator.client.del(`${notePath(target.playerId)}/${note.id}`),
    ]);

    expect(note.actorId).toBe(operator.userId);
    expect(new Date(note.createdAt).getTime()).toBeGreaterThanOrEqual(startedAt - 5_000);
    expect(new Date(note.createdAt).getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
    expect(edits.map((res) => res.ok)).toEqual([false, false, false]);
    const stored = (await listNotes(operator.client, target.playerId)).items;
    expect(stored).toEqual([note]);
  });
});

describe('player deletion', () => {
  it('an admin with the permission deletes a player and the account no longer signs in', async () => {
    const operator = await newOperator('pm-remover');
    const target = await newPlayer(e2e.app, `pmremove${shortId()}`);
    expect((await target.client.get('/profile')).status).toBe(200);

    const res = await operator.client.del(`/players/${target.playerId}`);

    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({ success: true });
    expect((await fetchPlayer(target.playerId)).status).toBe('closed');
    expect((await target.client.get('/profile')).status).toBe(401);
    const login = await e2e.app.app.request('/identity/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: target.email, password: 'password1234' }),
    });
    expect(login.status).toBe(403);
    const [row] = await auditRows('admin.player.removed', target.playerId);
    expect(row).toEqual(
      expect.objectContaining({
        actorId: operator.userId,
        actorType: 'admin',
        before: { status: 'active' },
        after: { status: 'closed' },
      }),
    );
  });

  it('an admin without the permission is refused with forbidden', async () => {
    const viewer = await newReadOnlyOperator('pm-noban');
    const outsider = await newOperatorWithoutPlayerAccess('pm-nodelete');
    const target = await newPlayer(e2e.app, `pmkeep${shortId()}`);

    const viewerRes = await viewer.client.del(`/players/${target.playerId}`);
    const outsiderRes = await outsider.client.del(`/players/${target.playerId}`);

    expect(viewerRes.status).toBe(403);
    expect(outsiderRes.status).toBe(403);
    expect((await errorOf(viewerRes)).code).toBe('FORBIDDEN');
    expect((await fetchPlayer(target.playerId)).status).toBe('active');
    expect((await target.client.get('/profile')).status).toBe(200);
    expect(await auditRows('admin.player.removed', target.playerId)).toEqual([]);
  });

  it.todo('deleting a player with a positive balance is refused');
});
