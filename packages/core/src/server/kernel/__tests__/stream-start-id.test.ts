import { describe, expect, it } from 'vitest';
import { streamStartIdFromEnv } from '../redis-streams-broker.js';

describe('streamStartIdFromEnv', () => {
  it('starts a new group at the tail unless told otherwise', () => {
    for (const split of [true, false]) {
      expect(streamStartIdFromEnv(undefined, split)).toBe('$');
      expect(streamStartIdFromEnv('', split)).toBe('$');
      expect(streamStartIdFromEnv('$', split)).toBe('$');
    }
  });

  it('starts a split service at the oldest retained event on 0', () => {
    expect(streamStartIdFromEnv('0', true)).toBe('0');
  });

  it('refuses 0 outside a split service', () => {
    expect(() => streamStartIdFromEnv('0', false)).toThrow(
      'EVENT_BUS_START_ID=0 needs SERVICE_MANIFEST',
    );
  });

  it('refuses anything else', () => {
    expect(() => streamStartIdFromEnv('1-0', true)).toThrow('EVENT_BUS_START_ID must be');
  });
});
