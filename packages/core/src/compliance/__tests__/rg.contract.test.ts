import { describe, it, expect } from 'vitest';
import {
  ActivateCoolingOffInputSchema,
  ActivateSelfExclusionInputSchema,
  LiftSelfExclusionInputSchema,
  SetPlayerLimitInputSchema,
} from '../contract/rg.js';

const USER = '11111111-1111-4111-8111-111111111111';

describe('SetPlayerLimitInputSchema session invariant', () => {
  const base = { userId: USER, amount: 100 };
  it('allows a session-time limit only with the session period', () => {
    expect(
      SetPlayerLimitInputSchema.safeParse({ ...base, type: 'session', period: 'session' }).success,
    ).toBe(true);
    expect(
      SetPlayerLimitInputSchema.safeParse({ ...base, type: 'deposit', period: 'daily' }).success,
    ).toBe(true);
  });
  it('rejects a mismatched type/period', () => {
    expect(
      SetPlayerLimitInputSchema.safeParse({ ...base, type: 'deposit', period: 'session' }).success,
    ).toBe(false);
    expect(
      SetPlayerLimitInputSchema.safeParse({ ...base, type: 'session', period: 'daily' }).success,
    ).toBe(false);
  });
});

describe('ActivateCoolingOffInputSchema', () => {
  it('accepts the 24h..1008h window with a reason', () => {
    expect(
      ActivateCoolingOffInputSchema.safeParse({ userId: USER, durationHours: 24, reason: 'x' })
        .success,
    ).toBe(true);
    expect(
      ActivateCoolingOffInputSchema.safeParse({ userId: USER, durationHours: 1008, reason: 'x' })
        .success,
    ).toBe(true);
  });

  it('rejects durations outside the window', () => {
    expect(
      ActivateCoolingOffInputSchema.safeParse({ userId: USER, durationHours: 23, reason: 'x' })
        .success,
    ).toBe(false);
    expect(
      ActivateCoolingOffInputSchema.safeParse({ userId: USER, durationHours: 1009, reason: 'x' })
        .success,
    ).toBe(false);
  });

  it('requires a non-empty reason', () => {
    expect(
      ActivateCoolingOffInputSchema.safeParse({ userId: USER, durationHours: 24, reason: '' })
        .success,
    ).toBe(false);
  });
});

describe('ActivateSelfExclusionInputSchema', () => {
  it('accepts a permanent exclusion without a duration', () => {
    expect(
      ActivateSelfExclusionInputSchema.safeParse({
        userId: USER,
        permanent: true,
        reason: 'x',
        confirm: true,
      }).success,
    ).toBe(true);
  });

  it('requires durationMonths (>= 6) for a fixed-term exclusion', () => {
    expect(
      ActivateSelfExclusionInputSchema.safeParse({
        userId: USER,
        permanent: false,
        reason: 'x',
        confirm: true,
      }).success,
    ).toBe(false);
    expect(
      ActivateSelfExclusionInputSchema.safeParse({
        userId: USER,
        permanent: false,
        durationMonths: 5,
        reason: 'x',
        confirm: true,
      }).success,
    ).toBe(false);
    expect(
      ActivateSelfExclusionInputSchema.safeParse({
        userId: USER,
        permanent: false,
        durationMonths: 6,
        reason: 'x',
        confirm: true,
      }).success,
    ).toBe(true);
  });

  it('requires an explicit confirm:true', () => {
    expect(
      ActivateSelfExclusionInputSchema.safeParse({
        userId: USER,
        permanent: true,
        reason: 'x',
        confirm: false,
      }).success,
    ).toBe(false);
  });
});

describe('LiftSelfExclusionInputSchema', () => {
  it('requires reason and confirm:true', () => {
    expect(
      LiftSelfExclusionInputSchema.safeParse({ userId: USER, reason: 'x', confirm: true }).success,
    ).toBe(true);
    expect(
      LiftSelfExclusionInputSchema.safeParse({ userId: USER, reason: '', confirm: true }).success,
    ).toBe(false);
    expect(
      LiftSelfExclusionInputSchema.safeParse({ userId: USER, reason: 'x', confirm: false }).success,
    ).toBe(false);
  });
});
