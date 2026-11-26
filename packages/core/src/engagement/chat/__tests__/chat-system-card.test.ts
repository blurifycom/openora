import { describe, expect, it } from 'vitest';
import { resolveSystemCardWrite } from '../service/chat-system-card.service.js';

const stored = (version: number) => ({
  roomId: 'room-1',
  userId: 'actor-1',
  type: 'system' as const,
  version,
});
const incoming = (version: number) => ({ roomId: 'room-1', actorId: 'actor-1', version });

describe('system card write resolution', () => {
  it.todo('a new card key resolves to an insert');

  it('a repeated card with the same key and the same version resolves to a no-op', () => {
    expect(resolveSystemCardWrite(stored(3), incoming(3))).toBe('stale');
  });

  it('a card with a higher version resolves to an update', () => {
    expect(resolveSystemCardWrite(stored(3), incoming(4))).toBe('updated');
  });

  it.todo('an update keeps the original post time');

  it('a card with an older version never overwrites a newer one', () => {
    expect(resolveSystemCardWrite(stored(5), incoming(4))).toBe('stale');
  });

  it('a stored row that is not this actor system card in this room is never overwritten', () => {
    expect(resolveSystemCardWrite({ ...stored(1), type: 'user' as const }, incoming(9))).toBe(
      'conflict',
    );
    expect(resolveSystemCardWrite({ ...stored(1), roomId: 'room-2' }, incoming(9))).toBe(
      'conflict',
    );
    expect(resolveSystemCardWrite({ ...stored(1), userId: 'actor-2' }, incoming(9))).toBe(
      'conflict',
    );
  });
});
