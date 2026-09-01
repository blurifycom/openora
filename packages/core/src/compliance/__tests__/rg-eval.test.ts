import { describe, it, expect } from 'vitest';
import { RG_FLAG_THRESHOLD_PCT } from '@openora/core/contracts';
import {
  periodWindow,
  thresholdPct,
  isAtThreshold,
  pendingChangeStatus,
} from '../service/rg-eval.js';

const NOW = new Date('2026-07-06T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

describe('periodWindow', () => {
  it('daily window is the trailing 24h', () => {
    const { from, to } = periodWindow('daily', NOW);
    expect(to).toEqual(NOW);
    expect(NOW.getTime() - from.getTime()).toBe(DAY);
  });

  it('weekly window is the trailing 7 days', () => {
    const { from } = periodWindow('weekly', NOW);
    expect(NOW.getTime() - from.getTime()).toBe(7 * DAY);
  });

  it('monthly window is the trailing 30 days', () => {
    const { from } = periodWindow('monthly', NOW);
    expect(NOW.getTime() - from.getTime()).toBe(30 * DAY);
  });

  it('session window is a zero-length point (handled by the sweep, not spend)', () => {
    const { from, to } = periodWindow('session', NOW);
    expect(from).toEqual(NOW);
    expect(to).toEqual(NOW);
  });
});

describe('thresholdPct', () => {
  it('returns 0 for a non-positive limit', () => {
    expect(thresholdPct(50, 0)).toBe(0);
    expect(thresholdPct(50, -1)).toBe(0);
  });

  it('computes the ratio as a percentage', () => {
    expect(thresholdPct(80, 100)).toBe(80);
    expect(thresholdPct(50, 200)).toBe(25);
  });
});

describe('isAtThreshold (80% boundary)', () => {
  it('raises exactly at 80%', () => {
    expect(isAtThreshold(80, 100)).toBe(true);
    expect(RG_FLAG_THRESHOLD_PCT).toBe(80);
  });

  it('does not raise just below 80%', () => {
    expect(isAtThreshold(79.99, 100)).toBe(false);
  });

  it('raises above 80% and at/over the limit', () => {
    expect(isAtThreshold(90, 100)).toBe(true);
    expect(isAtThreshold(100, 100)).toBe(true);
  });
});

describe('pendingChangeStatus', () => {
  const row = (over: Partial<Parameters<typeof pendingChangeStatus>[0]> = {}) => ({
    pendingKind: 'increase' as string | null,
    pendingEffectiveAt: new Date(NOW.getTime() + DAY) as Date | null,
    pendingExpiresAt: new Date(NOW.getTime() + 8 * DAY) as Date | null,
    ...over,
  });

  it('reports no request when none is parked', () => {
    expect(pendingChangeStatus(row({ pendingKind: null }), NOW)).toBeNull();
  });

  it('reports no request when the kind is set but the deadline is not', () => {
    expect(pendingChangeStatus(row({ pendingEffectiveAt: null }), NOW)).toBeNull();
  });

  it('is waiting while the cool-down is still running', () => {
    expect(pendingChangeStatus(row(), NOW)).toBe('waiting');
  });

  it('is ready once the cool-down has elapsed', () => {
    expect(pendingChangeStatus(row({ pendingEffectiveAt: NOW }), NOW)).toBe('ready');
  });

  it('is expired once the confirmation window has closed, however long it was ready', () => {
    expect(
      pendingChangeStatus(
        row({ pendingEffectiveAt: new Date(NOW.getTime() - 8 * DAY), pendingExpiresAt: NOW }),
        NOW,
      ),
    ).toBe('expired');
  });

  it('a zero cool-down is confirmable at once - it is not "no confirmation"', () => {
    expect(pendingChangeStatus(row({ pendingEffectiveAt: NOW }), NOW)).toBe('ready');
  });
});
