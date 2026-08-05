import { describe, expect, it } from 'vitest';
import { removePlayerTagSchema, replacePlayerTagSchema } from '../tag.js';

const removeBase = {
  playerId: '11111111-1111-4111-8111-111111111111',
  tagKey: 'vip' as const,
  removalActor: 'manual' as const,
  removalActorUserId: null,
};

const replaceBase = {
  playerId: '11111111-1111-4111-8111-111111111111',
  tagKey: 'level' as const,
  assignReason: 'level changed',
  assignActor: 'scheduled' as const,
  assignActorUserId: null,
};

describe('player tag removal reason schemas', () => {
  it.each([
    ['empty', ''],
    ['whitespace-only', '   '],
    ['four non-whitespace characters', ' abcd '],
  ])('rejects %s for removePlayerTag', (_label, removalReason) => {
    expect(removePlayerTagSchema.safeParse({ ...removeBase, removalReason }).success).toBe(false);
  });

  it('allows a missing reason so the service can apply sticky-tag rules', () => {
    expect(removePlayerTagSchema.safeParse(removeBase).success).toBe(true);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace-only', '   '],
    ['four non-whitespace characters', ' abcd '],
  ])('rejects %s for replacePlayerTag', (_label, removalReason) => {
    expect(replacePlayerTagSchema.safeParse({ ...replaceBase, removalReason }).success).toBe(false);
  });

  it('accepts exactly five non-whitespace characters and trims removePlayerTag output', () => {
    expect(
      removePlayerTagSchema.parse({ ...removeBase, removalReason: '  abcde  ' }).removalReason,
    ).toBe('abcde');
  });

  it('accepts exactly five non-whitespace characters and trims replacePlayerTag output', () => {
    expect(
      replacePlayerTagSchema.parse({ ...replaceBase, removalReason: '  abcde  ' }).removalReason,
    ).toBe('abcde');
  });
});
