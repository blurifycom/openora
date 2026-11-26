import { describe, expect, it } from 'vitest';
import { streamStartIdFromEnv } from '../redis-streams-broker.js';

describe('streamStartIdFromEnv', () => {
  it('starts a new group at the tail unless told otherwise', () => {
    expect(streamStartIdFromEnv(undefined)).toBe('$');
    expect(streamStartIdFromEnv('')).toBe('$');
    expect(streamStartIdFromEnv('$')).toBe('$');
  });

  it('starts a new group at the oldest retained event on 0', () => {
    expect(streamStartIdFromEnv('0')).toBe('0');
  });

  it('refuses anything else', () => {
    expect(() => streamStartIdFromEnv('1-0')).toThrow('EVENT_BUS_START_ID must be');
  });
});
