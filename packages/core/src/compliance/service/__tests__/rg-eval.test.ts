import { describe, it } from 'vitest';

describe('thresholdPct', () => {
  it.todo('returns 0 when the limit is zero');
  it.todo('returns 0 when the limit is negative');
  it.todo('returns the percentage of actual against the limit');
  it.todo('returns more than 100 when actual exceeds the limit');
});

describe('isAtThreshold', () => {
  it.todo('is false just below the flag threshold');
  it.todo('is true exactly at the flag threshold');
  it.todo('is true above the flag threshold');
  it.todo('is false for a non-positive limit');
});

describe('pendingChangeStatus', () => {
  it.todo('returns null when there is no pending kind');
  it.todo('returns null when the pending kind has no effective time');
  it.todo('returns waiting before the effective time');
  it.todo('returns ready exactly at the effective time');
  it.todo('returns expired exactly at the expiry time');
  it.todo('returns ready after the effective time when there is no expiry');
  it.todo('prefers expired over ready when both times have passed');
});
