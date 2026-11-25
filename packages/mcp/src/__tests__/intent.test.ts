import { describe, it } from 'vitest';

describe('classifyIntent', () => {
  it.todo('an ask naming a vendor, payment or notification is an adapter');
  it.todo('an ask naming a page, screen or dashboard is a ui-page');
  it.todo('an ask naming an endpoint or route is a route');
  it.todo('an ask naming a feature, bonus or tournament is a feature');
  it.todo('adapter wins over ui-page when both are named');
  it.todo('an ask matching nothing is unsure');
  it.todo('matching is case-insensitive and whole-word');
});
