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

describe('mapEventToRecord: gaming.category.created', () => {
  it('includes category translations and sort config in the audited snapshot', async () => {
    const categoryId = '55555555-5555-4555-8555-555555555555';
    const row = await mapEventToRecord('gaming.category.created', {
      categoryId,
      slug: 'table-games',
      name: 'Table Games',
      translations: { de: { name: 'Tischspiele' } },
      icon: null,
      sortOrder: 0,
      isActive: true,
      sortKey: 'manual',
      sortDirection: null,
      sortParams: {},
      rankedAt: null,
      actorId: adminId,
    });

    expect(row).toMatchObject({
      actorType: 'admin',
      resourceType: 'game_category',
      resourceId: categoryId,
      after: {
        translations: { de: { name: 'Tischspiele' } },
        sortKey: 'manual',
        sortDirection: null,
        sortParams: {},
        rankedAt: null,
      },
    });
  });
});

describe('mapEventToRecord: gaming.provider.created', () => {
  it('includes every aggregator mapping in the audited snapshot', async () => {
    const providerId = '55555555-5555-4555-8555-555555555556';
    const aggregatorMappings = [
      { aggregator: 'aggregation-a', vendorId: 'studio-7' },
      { aggregator: 'aggregation-b', vendorId: 'vendor-19' },
    ];
    const row = await mapEventToRecord('gaming.provider.created', {
      providerId,
      slug: 'multi-rail-studio',
      name: 'Multi Rail Studio',
      aggregatorMappings,
      logoUrl: null,
      isActive: false,
      actorId: adminId,
    });

    expect(row).toMatchObject({
      actorType: 'admin',
      actorId: adminId,
      resourceType: 'game_provider',
      resourceId: providerId,
      after: { aggregatorMappings, isActive: false },
    });
  });
});

describe('mapEventToRecord: gaming tag catalog mutations', () => {
  const tagId = '77777777-7777-4777-8777-777777777777';
  const snapshot = {
    name: 'Featured',
    type: 'custom',
    visibility: 'visible',
    metadata: null,
  };

  it('audits tag creation against the game tag resource', async () => {
    const row = await mapEventToRecord('gaming.tag.created', {
      tagId,
      actorId: adminId,
      ...snapshot,
    });

    expect(row).toMatchObject({
      actorType: 'admin',
      actorId: adminId,
      resourceType: 'game_tag',
      resourceId: tagId,
      after: snapshot,
    });
  });

  it('audits tag updates against the game tag resource', async () => {
    const row = await mapEventToRecord('gaming.tag.updated', {
      tagId,
      actorId: adminId,
      before: { ...snapshot, visibility: 'invisible' },
      after: snapshot,
    });

    expect(row).toMatchObject({
      actorType: 'admin',
      actorId: adminId,
      resourceType: 'game_tag',
      resourceId: tagId,
      before: { visibility: 'invisible' },
      after: snapshot,
    });
  });

  it('audits affected games when a game tag is deleted', async () => {
    const affectedGameId = '88888888-8888-4888-8888-888888888888';
    const row = await mapEventToRecord('gaming.tag.deleted', {
      tagId,
      actorId: adminId,
      before: snapshot,
      after: { deleted: true, affectedGameIds: [affectedGameId] },
    });

    expect(row).toMatchObject({
      resourceType: 'game_tag',
      resourceId: tagId,
      before: snapshot,
      after: { deleted: true, affectedGameIds: [affectedGameId] },
    });
  });
});

describe('mapEventToRecord: gaming.category.games_reordered', () => {
  it('audits the category resource with the before/after ordered game-id lists, sort key, direction, and params', async () => {
    const categoryId = '55555555-5555-4555-8555-555555555555';
    const gameA = '66666666-6666-4666-8666-666666666666';
    const gameB = '77777777-7777-4777-8777-777777777777';

    const row = await mapEventToRecord('gaming.category.games_reordered', {
      categoryId,
      actorId: adminId,
      before: [gameA, gameB],
      after: [gameB, gameA],
      sortKeyBefore: 'name',
      sortKeyAfter: 'manual',
      sortDirectionBefore: 'asc',
      sortDirectionAfter: null,
      sortParamsBefore: { window: 7 },
      sortParamsAfter: {},
    });

    expect(row).toMatchObject({
      actorType: 'admin',
      actorId: adminId,
      resourceType: 'game_category',
      resourceId: categoryId,
      before: {
        gameIds: [gameA, gameB],
        sortKey: 'name',
        sortDirection: 'asc',
        sortParams: { window: 7 },
      },
      after: { gameIds: [gameB, gameA], sortKey: 'manual', sortDirection: null, sortParams: {} },
    });
  });
});

describe('mapEventToRecord: gaming.category.pins_updated', () => {
  it('audits the category resource with the before/after pinned-slot lists', async () => {
    const categoryId = '55555555-5555-4555-8555-555555555555';
    const gameA = '66666666-6666-4666-8666-666666666666';
    const gameB = '77777777-7777-4777-8777-777777777777';

    const row = await mapEventToRecord('gaming.category.pins_updated', {
      categoryId,
      actorId: adminId,
      before: [{ gameId: gameA, position: 0 }],
      after: [
        { gameId: gameB, position: 0 },
        { gameId: gameA, position: 1 },
      ],
    });

    expect(row).toMatchObject({
      actorType: 'admin',
      actorId: adminId,
      resourceType: 'game_category',
      resourceId: categoryId,
      before: { pins: [{ gameId: gameA, position: 0 }] },
      after: {
        pins: [
          { gameId: gameB, position: 0 },
          { gameId: gameA, position: 1 },
        ],
      },
    });
  });
});

describe('mapEventToRecord: gaming.games.bulk_updated', () => {
  const gameId = '99999999-9999-4999-8999-999999999999';
  const otherGameId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const providerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const emptyTarget = { gameIds: [gameId], providerIds: [] };
  const emptyNotFound = { gameIds: [], providerIds: [] };

  it('audits a set_active call against the game resource with no single resourceId', async () => {
    const bulkOperationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const row = await mapEventToRecord('gaming.games.bulk_updated', {
      operation: 'set_active',
      actorId: adminId,
      bulkOperationId,
      target: emptyTarget,
      isActive: false,
      changedGameIds: [gameId],
      changedProviderIds: [providerId],
      notFound: emptyNotFound,
    });

    expect(row).toMatchObject({
      actorType: 'admin',
      actorId: adminId,
      resourceType: 'game',
      resourceId: null,
      before: { isActive: true, gameIds: [gameId], providerIds: [providerId] },
      after: { operation: 'set_active', isActive: false },
      correlationId: bulkOperationId,
    });
  });

  it('audits an add_tags call recording exactly which ids each game was missing', async () => {
    const tagA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const tagB = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const addedLinks = [
      { gameId, tagIds: [tagB] },
      { gameId: otherGameId, tagIds: [tagA, tagB] },
    ];
    const row = await mapEventToRecord('gaming.games.bulk_updated', {
      operation: 'add_tags',
      actorId: adminId,
      target: emptyTarget,
      tagIds: [tagA, tagB],
      addedLinks,
      notFound: emptyNotFound,
    });

    expect(row).toMatchObject({
      actorType: 'admin',
      actorId: adminId,
      resourceType: 'game',
      resourceId: null,
      before: {
        addedLinks: [
          { gameId, tagIds: [] },
          { gameId: otherGameId, tagIds: [] },
        ],
      },
      after: { operation: 'add_tags', addedLinks },
      correlationId: null,
    });
  });

  it('audits an add_categories call the same way, keyed on categoryIds', async () => {
    const categoryId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const addedLinks = [{ gameId, categoryIds: [categoryId] }];
    const row = await mapEventToRecord('gaming.games.bulk_updated', {
      operation: 'add_categories',
      actorId: adminId,
      target: emptyTarget,
      categoryIds: [categoryId],
      addedLinks,
      notFound: emptyNotFound,
    });

    expect(row).toMatchObject({
      actorType: 'admin',
      actorId: adminId,
      resourceType: 'game',
      resourceId: null,
      before: { addedLinks: [{ gameId, categoryIds: [] }] },
      after: { operation: 'add_categories', addedLinks },
    });
  });
});

describe('mapEventToRecord: gaming.provider.updated', () => {
  const providerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const snapshot = {
    slug: 'acme',
    name: 'Acme',
    aggregatorMappings: [],
    logoUrl: null,
    metadata: null,
    isActive: true,
  };

  it('carries the bulk operation id as correlationId when this flip came from a bulk/active call', async () => {
    const bulkOperationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const row = await mapEventToRecord('gaming.provider.updated', {
      providerId,
      actorId: adminId,
      bulkOperationId,
      before: { ...snapshot, isActive: true },
      after: { ...snapshot, isActive: false },
    });

    expect(row).toMatchObject({
      actorType: 'admin',
      actorId: adminId,
      resourceType: 'game_provider',
      resourceId: providerId,
      before: { isActive: true },
      after: { isActive: false },
      correlationId: bulkOperationId,
    });
  });

  it('has no correlationId for an ordinary, non-bulk provider update', async () => {
    const row = await mapEventToRecord('gaming.provider.updated', {
      providerId,
      actorId: adminId,
      before: { ...snapshot, isActive: true },
      after: { ...snapshot, isActive: false },
    });

    expect(row).toMatchObject({
      resourceType: 'game_provider',
      resourceId: providerId,
      correlationId: null,
    });
  });
});

describe('mapEventToRecord: gaming.game.availability_changed', () => {
  it('audits a vendor outage flip as a system action on the game', async () => {
    const gameId = '99999999-9999-4999-8999-999999999999';
    const row = await mapEventToRecord('gaming.game.availability_changed', {
      gameId,
      before: { isUnavailable: false },
      after: { isUnavailable: true },
    });

    expect(row).toMatchObject({
      actorType: 'system',
      resourceType: 'game',
      resourceId: gameId,
      before: { isUnavailable: false },
      after: { isUnavailable: true },
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

describe('mapEventToRecord: wallet.withdrawal.failed', () => {
  const transactionId = '88888888-8888-4888-8888-888888888888';

  it('attributes an admin-reviewed failure to that admin', async () => {
    const row = await mapEventToRecord('wallet.withdrawal.failed', {
      userId,
      amount: '10.00',
      currency: 'USDT',
      transactionId,
      adminId,
    });

    expect(row).toMatchObject({
      actorType: 'admin',
      actorId: adminId,
      resourceType: 'withdrawal',
      resourceId: transactionId,
      result: 'failure',
    });
  });

  it('attributes an auto-approved or webhook failure (null adminId) to the system', async () => {
    const row = await mapEventToRecord('wallet.withdrawal.failed', {
      userId,
      amount: '10.00',
      currency: 'USDT',
      transactionId,
      adminId: null,
    });

    expect(row).toMatchObject({
      actorType: 'system',
      actorId: null,
      resourceType: 'withdrawal',
      resourceId: transactionId,
      result: 'failure',
    });
  });
});

describe('mapEventToRecord: identity.email.changed', () => {
  it('records the address transition as a player self-action', async () => {
    const row = await mapEventToRecord('identity.email.changed', {
      userId,
      playerId,
      previousEmail: 'old@example.com',
      newEmail: 'new@example.com',
    });

    expect(row).toMatchObject({
      actorType: 'player',
      actorId: playerId,
      resourceType: 'user',
      resourceId: userId,
      before: { email: 'old@example.com' },
      after: { email: 'new@example.com' },
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
