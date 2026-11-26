import { describe, expect, it } from 'vitest';
import { resolveSystemCardWrite } from '../chat-system-card.service.js';

const ROOM = '3f6c1d0e-7a41-4b8e-9d52-0a1b2c3d4e5f';
const OTHER_ROOM = '9b2e5f40-1c3d-4a6b-8e7f-5d4c3b2a1f00';
const ACTOR = 'a1b2c3d4-0000-4000-8000-000000000001';
const OTHER_ACTOR = 'a1b2c3d4-0000-4000-8000-000000000002';

const stored = (over: Partial<Parameters<typeof resolveSystemCardWrite>[0]>) => ({
  roomId: ROOM,
  userId: ACTOR,
  type: 'system' as const,
  version: 3,
  ...over,
});
const incoming = (over: Partial<Parameters<typeof resolveSystemCardWrite>[1]>) => ({
  roomId: ROOM,
  actorId: ACTOR,
  version: 4,
  ...over,
});

describe('resolveSystemCardWrite', () => {
  it.each([
    [4, 'updated'],
    [100, 'updated'],
    [3, 'stale'],
    [2, 'stale'],
    [0, 'stale'],
    [-1, 'stale'],
  ] as const)('applies version %s over stored 3 as %s', (version, expected) => {
    expect(resolveSystemCardWrite(stored({}), incoming({ version }))).toBe(expected);
  });

  it('refuses to overwrite a stored player message', () => {
    expect(resolveSystemCardWrite(stored({ type: 'user' }), incoming({ version: 99 }))).toBe(
      'conflict',
    );
  });

  it('refuses a card that moves into another room', () => {
    expect(resolveSystemCardWrite(stored({}), incoming({ roomId: OTHER_ROOM, version: 99 }))).toBe(
      'conflict',
    );
  });

  it('refuses a card written by another actor', () => {
    expect(
      resolveSystemCardWrite(stored({}), incoming({ actorId: OTHER_ACTOR, version: 99 })),
    ).toBe('conflict');
  });

  it('matches the global room stored as null against an incoming null', () => {
    expect(resolveSystemCardWrite(stored({ roomId: null }), incoming({ roomId: null }))).toBe(
      'updated',
    );
  });

  it('refuses a global card over a room card', () => {
    expect(resolveSystemCardWrite(stored({}), incoming({ roomId: null }))).toBe('conflict');
  });

  it('refuses a room card over a global card', () => {
    expect(resolveSystemCardWrite(stored({ roomId: null }), incoming({}))).toBe('conflict');
  });

  it('treats a conflict as conflict even when the version is stale', () => {
    expect(resolveSystemCardWrite(stored({ type: 'user' }), incoming({ version: 0 }))).toBe(
      'conflict',
    );
  });
});
