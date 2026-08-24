import { describe, it, expect } from 'vitest';
import {
  MIN_PLAYER_AGE_YEARS,
  UpdatePlayerProfileInputSchema,
  isAdultDateOfBirth,
} from '../schemas/player.js';

const NOW = new Date('2026-08-24T00:00:00Z');

function isoBirthday(yearsAgo: number, offsetDays = 0) {
  const d = new Date(NOW);
  d.setUTCFullYear(d.getUTCFullYear() - yearsAgo);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

describe('isAdultDateOfBirth', () => {
  it('passes a player on their own 18th birthday', () => {
    expect(isAdultDateOfBirth(isoBirthday(MIN_PLAYER_AGE_YEARS), NOW)).toBe(true);
  });

  it('rejects a player one day short of 18', () => {
    expect(isAdultDateOfBirth(isoBirthday(MIN_PLAYER_AGE_YEARS, 1), NOW)).toBe(false);
  });

  it('rejects a date in the future', () => {
    expect(isAdultDateOfBirth('2030-01-01', NOW)).toBe(false);
  });
});

describe('UpdatePlayerProfileInputSchema', () => {
  it('accepts the full profile the signup step collects', () => {
    const input = {
      firstName: 'Ada',
      lastName: 'Lovelace',
      dateOfBirth: '1990-05-17',
      phone: '+441632960001',
      country: 'GB',
    };

    expect(UpdatePlayerProfileInputSchema.parse(input)).toEqual(input);
  });

  it('accepts null to clear an optional field', () => {
    expect(UpdatePlayerProfileInputSchema.safeParse({ phone: null }).success).toBe(true);
  });

  // Without this the handler reaches `db.update().set({})`, which drizzle rejects at
  // runtime - a 500 on a form where the player simply changed nothing.
  it('rejects an update that carries no fields', () => {
    expect(UpdatePlayerProfileInputSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a country display name instead of an ISO 3166-1 alpha-2 code', () => {
    expect(UpdatePlayerProfileInputSchema.safeParse({ country: 'United Kingdom' }).success).toBe(
      false,
    );
  });

  it('rejects a phone number that is not E.164', () => {
    expect(UpdatePlayerProfileInputSchema.safeParse({ phone: '+44 1632 960001' }).success).toBe(
      false,
    );
  });

  it('rejects a date of birth under the minimum age', () => {
    const result = UpdatePlayerProfileInputSchema.safeParse({ dateOfBirth: '2020-01-01' });

    expect(result.success).toBe(false);
  });
});
