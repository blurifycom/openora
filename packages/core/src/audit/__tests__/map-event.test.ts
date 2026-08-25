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
