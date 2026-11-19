import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DRIZZLE, EVENT_BUS } from '@openora/core/server';
import { NotificationsService } from '@openora/core/engagement/notifications';
import { notification } from '@openora/core/engagement/schema/notifications';
import {
  readJson,
  registerAndMaterializePlayer,
  type TestDb,
  type TestApp,
  bootE2e,
  closeE2e,
} from '../index.js';

let db: TestDb;
let app: TestApp;

const drizzle = () => app.container.get(DRIZZLE).db;
const service = () =>
  new NotificationsService(app.container.get(DRIZZLE), app.container.get(EVENT_BUS));

beforeAll(async () => {
  ({ db, app } = await bootE2e());
}, 60_000);

afterAll(async () => {
  await closeE2e({ app, db });
});

describe('the removed chat.tip.received notification type', () => {
  it('hides a stored chat.tip.received row from the list while total still counts it', async () => {
    const { client, userId } = await registerAndMaterializePlayer(app, {
      email: `notif-legacy-tip-${randomUUID()}@example.test`,
    });
    await drizzle()
      .insert(notification)
      .values({
        userId,
        type: 'chat.tip.received',
        params: { senderUsername: 'bob', amount: '3', currency: 'USD' },
      });
    const kept = await service().create({
      userId,
      type: 'chat.donation.received',
      params: { senderUsername: 'bob', amount: '4', currency: 'USD' },
    });

    const res = await client.get('/notifications');

    expect(res.status).toBe(200);
    const list = await readJson(res);
    expect(list.items.map((item: { id: string }) => item.id)).toEqual([kept?.id]);
    expect(list.total).toBe(2);
  });
});
