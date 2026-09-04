import { describe, it, expect } from 'vitest';
import { mapEventToRecord } from '../plugin.js';

const userId = '11111111-1111-1111-1111-111111111111';
const playerId = '22222222-2222-2222-2222-222222222222';
const adminId = '33333333-3333-3333-3333-333333333333';
const sessionId = '44444444-4444-4444-4444-444444444444';

describe('mapEventToRecord: identity.session.revoked', () => {
  it('keeps a self-revoke a player action even though it carries an actorId', async () => {
    const row = await mapEventToRecord('identity.session.revoked', {
      userId,
      playerId,
      sessionId,
      actorId: userId,
    });

    expect(row).toMatchObject({ actorType: 'player', actorId: playerId, resourceId: sessionId });
  });

  it('marks a revoke by another user an admin action', async () => {
    const row = await mapEventToRecord('identity.session.revoked', {
      userId,
      playerId,
      sessionId,
      actorId: adminId,
    });

    expect(row).toMatchObject({ actorType: 'admin', actorId: adminId, resourceId: sessionId });
  });
});

describe('mapEventToRecord: cms.banner.schedule.updated', () => {
  it('audits the schedule resource and records both endsAt values', async () => {
    const bannerScheduleId = '55555555-5555-4555-8555-555555555555';
    const bannerConfigurationId = '66666666-6666-4666-8666-666666666666';
    const beforeEndsAt = '2026-01-01T01:00:00.000Z';
    const endsAt = '2026-01-01T02:00:00.000Z';

    const row = await mapEventToRecord('cms.banner.schedule.updated', {
      bannerScheduleId,
      bannerConfigurationId,
      placement: 'home-top',
      startsAt: '2026-01-01T00:00:00.000Z',
      endsAt,
      before: { endsAt: beforeEndsAt },
      actorId: adminId,
    });

    expect(row).toMatchObject({
      actorType: 'admin',
      actorId: adminId,
      resourceType: 'banner_schedule',
      resourceId: bannerScheduleId,
      before: { endsAt: beforeEndsAt },
      after: { endsAt, bannerConfigurationId, placement: 'home-top' },
    });
  });
});

describe('mapEventToRecord: identity.trusted_device.revoked / identity.2fa.reset', () => {
  const deviceId = '55555555-5555-5555-5555-555555555555';

  it('marks a self-service trust teardown a player action, not an admin one', async () => {
    const row = await mapEventToRecord('identity.trusted_device.revoked', {
      userId,
      deviceId,
      actorId: userId,
    });

    expect(row).toMatchObject({ actorType: 'player', resourceType: 'user', resourceId: userId });
  });

  it('marks a cross-user device revoke an admin action', async () => {
    const row = await mapEventToRecord('identity.trusted_device.revoked', {
      userId,
      deviceId,
      actorId: adminId,
    });

    expect(row).toMatchObject({ actorType: 'admin', actorId: adminId, resourceId: userId });
  });

  it('attributes an AdminGuard-forced trust revoke to the system', async () => {
    const row = await mapEventToRecord('identity.trusted_device.revoked', {
      userId,
      deviceId,
    });

    expect(row).toMatchObject({ actorType: 'system', actorId: null, resourceId: userId });
  });

  it('marks a Super Admin 2FA reset an admin action against the target account', async () => {
    const row = await mapEventToRecord('identity.2fa.reset', {
      userId,
      playerId: null,
      actorId: adminId,
    });

    expect(row).toMatchObject({ actorType: 'admin', actorId: adminId, resourceId: userId });
  });
});

describe('mapEventToRecord: identity.user.registration.failed', () => {
  it('records a rejected attempt as a failure against the registration resource', async () => {
    const row = await mapEventToRecord('identity.user.registration.failed', {
      email: 'taken@example.com',
      username: 'taken_handle',
      reason: 'username_taken',
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
    });

    expect(row).toMatchObject({
      result: 'failure',
      resourceType: 'registration',
      actorType: 'system',
      resourceId: null,
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
    });
  });

  it('carries the address and reason through, since a rejected attempt has no actor', async () => {
    const row = await mapEventToRecord('identity.user.registration.failed', {
      email: 'blocked@example.com',
      reason: 'geo_blocked',
    });

    expect(row.after).toMatchObject({ email: 'blocked@example.com', reason: 'geo_blocked' });
    expect(row.actorId).toBeUndefined();
  });
});

describe('mapEventToRecord: chat room lifecycle after an owner account closes', () => {
  const roomId = '11111111-1111-4111-8111-111111111111';
  const previousOwnerId = '22222222-2222-4222-8222-222222222222';

  it('attributes an ownership transfer to the system, against the room', async () => {
    const row = await mapEventToRecord('chat.room.ownership.transferred', {
      roomId,
      roomName: 'Wheel Spin',
      previousOwnerId,
      newOwnerId: '33333333-3333-4333-8333-333333333333',
      reason: 'account-closed',
    });

    expect(row).toMatchObject({
      actorType: 'system',
      resourceType: 'chat_room',
      resourceId: roomId,
      after: {
        previousOwnerId,
        newOwnerId: '33333333-3333-4333-8333-333333333333',
        reason: 'account-closed',
      },
    });
  });

  it('records the countdown deadline and how many members it affects', async () => {
    const row = await mapEventToRecord('chat.room.scheduled_for_deletion', {
      roomId,
      roomName: 'Wheel Spin',
      previousOwnerId,
      memberIds: [previousOwnerId, '44444444-4444-4444-8444-444444444444'],
      scheduledDeletionAt: '2026-09-30T10:00:00.000Z',
    });

    expect(row).toMatchObject({
      actorType: 'system',
      resourceType: 'chat_room',
      resourceId: roomId,
      after: {
        previousOwnerId,
        scheduledDeletionAt: '2026-09-30T10:00:00.000Z',
        memberCount: 2,
      },
    });
  });

  it('records the cancellation when the closed owner comes back', async () => {
    const row = await mapEventToRecord('chat.room.deletion.cancelled', {
      roomId,
      roomName: 'Wheel Spin',
      ownerId: previousOwnerId,
      memberIds: [previousOwnerId, '44444444-4444-4444-8444-444444444444'],
    });

    expect(row).toMatchObject({
      actorType: 'system',
      resourceType: 'chat_room',
      resourceId: roomId,
      after: { ownerId: previousOwnerId, scheduledDeletionAt: null, memberCount: 2 },
    });
  });
});

describe('mapEventToRecord: player account closed and reopened', () => {
  const payload = {
    playerId: '55555555-5555-4555-8555-555555555555',
    userId: '66666666-6666-4666-8666-666666666666',
    actorId: '77777777-7777-4777-8777-777777777777',
  };

  it('attributes the closure to the acting admin, against the subject player', async () => {
    const row = await mapEventToRecord('player.account.closed', payload);

    expect(row).toMatchObject({
      actorType: 'admin',
      actorId: '77777777-7777-4777-8777-777777777777',
      resourceType: 'player',
      resourceId: '55555555-5555-4555-8555-555555555555',
      after: { closed: true },
    });
  });

  it('records the reopening the same way, so the pair reads as one story', async () => {
    const row = await mapEventToRecord('player.account.reopened', payload);

    expect(row).toMatchObject({
      actorType: 'admin',
      actorId: '77777777-7777-4777-8777-777777777777',
      resourceType: 'player',
      resourceId: '55555555-5555-4555-8555-555555555555',
      after: { closed: false },
    });
  });
});
