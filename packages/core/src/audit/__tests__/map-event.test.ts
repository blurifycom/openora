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
