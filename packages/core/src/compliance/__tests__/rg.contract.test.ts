import { describe, it, expect } from 'vitest';
import {
  ActivateCoolingOffInputSchema,
  ActivateSelfExclusionInputSchema,
  LiftCoolingOffInputSchema,
  LiftSelfExclusionInputSchema,
  RgFlagListItemSchema,
} from '../contract/rg.js';

const USER = '11111111-1111-4111-8111-111111111111';

describe('RgFlagListItemSchema.detail resilience', () => {
  const base = {
    id: USER,
    userId: USER,
    username: null,
    email: null,
    flagType: 'session_time' as const,
    limitType: null,
    status: 'active' as const,
    flaggedAt: new Date().toISOString(),
    clearedAt: null,
  };
  it('accepts a legacy/empty detail so one bad row cannot 500 the whole list', () => {
    expect(RgFlagListItemSchema.safeParse({ ...base, detail: {} }).success).toBe(true);
  });
  it('still accepts the known detail shapes', () => {
    expect(
      RgFlagListItemSchema.safeParse({
        ...base,
        detail: { sessionMinutes: 65, limitMinutes: 60, pct: 108 },
      }).success,
    ).toBe(true);
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
        isPermanent: true,
        reason: 'x',
        confirm: true,
      }).success,
    ).toBe(true);
  });

  it('requires durationMonths (>= 6) for a fixed-term exclusion', () => {
    expect(
      ActivateSelfExclusionInputSchema.safeParse({
        userId: USER,
        isPermanent: false,
        reason: 'x',
        confirm: true,
      }).success,
    ).toBe(false);
    expect(
      ActivateSelfExclusionInputSchema.safeParse({
        userId: USER,
        isPermanent: false,
        durationMonths: 5,
        reason: 'x',
        confirm: true,
      }).success,
    ).toBe(false);
    expect(
      ActivateSelfExclusionInputSchema.safeParse({
        userId: USER,
        isPermanent: false,
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
        isPermanent: true,
        reason: 'x',
        confirm: false,
      }).success,
    ).toBe(false);
  });
});

describe('LiftCoolingOffInputSchema', () => {
  it('requires a non-empty reason and takes no confirm flag', () => {
    expect(LiftCoolingOffInputSchema.safeParse({ userId: USER, reason: 'x' }).success).toBe(true);
    expect(LiftCoolingOffInputSchema.safeParse({ userId: USER, reason: '' }).success).toBe(false);
    expect(LiftCoolingOffInputSchema.safeParse({ userId: USER, reason: '   ' }).success).toBe(
      false,
    );
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
