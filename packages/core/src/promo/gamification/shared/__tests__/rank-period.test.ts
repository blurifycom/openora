import { describe, it } from 'vitest';

describe('lastCompletePeriod', () => {
  it.todo('daily ends at the anchor hour of today when it has passed and of yesterday when not');
  it.todo('weekly ends on the last anchor weekday at the anchor hour');
  it.todo('weekly handles a Sunday anchor and a Monday anchor');
  it.todo(
    'monthly ends on the anchor day of this month when passed and of the previous month when not',
  );
  it.todo('monthly clamps an anchor day past the end of a short month');
});

describe('openPeriodKey', () => {
  it.todo('starts where the last complete period ended');
  it.todo('a counter written during a period and the payout of that period use the same key');
  it.todo('formats daily keys with the hour and weekly and monthly keys with the date');
});
