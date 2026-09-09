import { describe, it, expect } from 'vitest';
import { GameTagBadgeSettingsSchema } from '../game.js';

describe('game tag badge settings', () => {
  it('defaults to the standard badge colors', () => {
    expect(GameTagBadgeSettingsSchema.parse({})).toEqual({
      badgeColor: '#3377ff',
      textColor: '#ffffff',
    });
  });

  it('accepts six-digit hex colors and rejects other formats', () => {
    expect(
      GameTagBadgeSettingsSchema.parse({ badgeColor: '#112233', textColor: '#ABCDEF' }),
    ).toEqual({ badgeColor: '#112233', textColor: '#ABCDEF' });
    expect(() =>
      GameTagBadgeSettingsSchema.parse({ badgeColor: 'white', textColor: '#ffffff' }),
    ).toThrow();
  });
});
