import { describe, it, expect } from 'vitest';
import { resolveSystemCardWrite } from '../service/chat-system-card.service.js';

const roomId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const stored = { roomId, userId: actorId, type: 'system', version: 1 } as const;

describe('resolveSystemCardWrite', () => {
  it('applies a higher version of the same card', () => {
    expect(resolveSystemCardWrite(stored, { roomId, actorId, version: 2 })).toBe('updated');
  });

  it('ignores an equal or lower version, so redelivery and a late post change nothing', () => {
    expect(resolveSystemCardWrite(stored, { roomId, actorId, version: 1 })).toBe('stale');
    expect(resolveSystemCardWrite({ ...stored, version: 2 }, { roomId, actorId, version: 1 })).toBe(
      'stale',
    );
  });

  it('refuses an id that names a message in another room, whatever the version', () => {
    const otherRoom = '33333333-3333-4333-8333-333333333333';
    expect(resolveSystemCardWrite(stored, { roomId: otherRoom, actorId, version: 2 })).toBe(
      'conflict',
    );
    expect(resolveSystemCardWrite(stored, { roomId: null, actorId, version: 2 })).toBe('conflict');
  });

  it("refuses an id that names another author's message or a player's own message", () => {
    const otherActor = '44444444-4444-4444-8444-444444444444';
    expect(resolveSystemCardWrite(stored, { roomId, actorId: otherActor, version: 2 })).toBe(
      'conflict',
    );
    expect(
      resolveSystemCardWrite({ ...stored, type: 'user' }, { roomId, actorId, version: 2 }),
    ).toBe('conflict');
  });
});
