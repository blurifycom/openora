import { describe, it } from 'vitest';

describe('financial analytics reports', () => {
  it.todo(
    'an admin with analytics permission reads the summary and deposits and withdrawals appear per currency',
  );
  it.todo('the summary excludes failed and pending payments');
  it.todo('ggr series is bucketed by the requested granularity within the date range');
  it.todo('products report lists revenue per product');
  it.todo('a range with no activity returns zero totals rather than an error');
  it.todo('an admin without the analytics permission is refused every report');
  it.todo('an unauthenticated caller is refused every report');
  it.todo('an inverted date range is rejected');
});
