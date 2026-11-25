import { describe, it } from 'vitest';

describe('isoDate and yesterdayOf', () => {
  it.todo('returns the UTC calendar day regardless of the local zone');
  it.todo('yesterday of the first of a month is the last day of the previous month');
  it.todo('yesterday of the first of January is the thirty-first of December');
});

describe('isStreakLive', () => {
  it.todo('is live when the last qualifying day is today');
  it.todo('is live when the last qualifying day is yesterday');
  it.todo('is not live when the last qualifying day is two days ago');
  it.todo('is not live when there is no qualifying day');
  it.todo('stays live at 23:59:59 UTC and counts yesterday as of 00:00:00 UTC the next day');
});

describe('activeRakebackRate', () => {
  it.todo('returns null when no milestone is at or below the current day');
  it.todo('returns the highest rate among milestones at or below the current day');
  it.todo('a later milestone with a lower rate never lowers the active rate');
  it.todo('picks the unranked and ranked uplift formulas independently');
});
