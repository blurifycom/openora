import { describe, expect, it } from 'vitest';
import { CHAT_ROOM_REACHES, GLOBAL_CHAT_ROOM_ID } from '@openora/core/contracts';
import { platformScopesFor, roomReach } from '../moderation-target.js';

describe('roomReach', () => {
  it.each([
    [GLOBAL_CHAT_ROOM_ID, true, 'global'],
    [GLOBAL_CHAT_ROOM_ID, false, 'global'],
    ['lobby', true, 'public'],
    ['lobby', false, 'private'],
    ['', true, 'public'],
    [`${GLOBAL_CHAT_ROOM_ID}x`, true, 'public'],
    [`${GLOBAL_CHAT_ROOM_ID} `, true, 'public'],
    [`x${GLOBAL_CHAT_ROOM_ID}`, false, 'private'],
  ] as const)('slug %j with isPublic %s reaches %s', (slug, isPublic, expected) => {
    expect(roomReach({ slug, isPublic })).toBe(expected);
  });
});

describe('platformScopesFor', () => {
  it('lets a global room be covered by its own scope, all-public and all', () => {
    expect(platformScopesFor('global')).toEqual([GLOBAL_CHAT_ROOM_ID, '__all_public', '__all']);
  });

  it('lets a public room be covered by all-public and all', () => {
    expect(platformScopesFor('public')).toEqual(['__all_public', '__all']);
  });

  it('lets a private room be covered by all only', () => {
    expect(platformScopesFor('private')).toEqual(['__all']);
  });

  it.each(CHAT_ROOM_REACHES)(
    'returns a copy of the %s scopes that callers can mutate safely',
    (reach) => {
      const first = platformScopesFor(reach);
      first.push('room');
      expect(platformScopesFor(reach)).not.toContain('room');
    },
  );

  it('never lets a private room be covered by all-public', () => {
    expect(platformScopesFor('private')).not.toContain('__all_public');
  });

  it.each(CHAT_ROOM_REACHES)('always includes __all for %s', (reach) => {
    expect(platformScopesFor(reach)).toContain('__all');
  });
});
