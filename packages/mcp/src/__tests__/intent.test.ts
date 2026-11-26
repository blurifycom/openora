import { describe, expect, it } from 'vitest';
import { classifyIntent } from '../intent.js';

describe('classifyIntent', () => {
  it.each([
    'swap the payment provider',
    'integrate Stripe',
    'add a new KYC vendor',
    'send an sms on login',
    'wire a gateway',
  ])('an ask naming a vendor, payment or notification is an adapter: %s', (ask) => {
    expect(classifyIntent(ask)).toBe('adapter');
  });

  it.each([
    'add a page for limits',
    'a new screen for players',
    'build a dashboard',
    'the backoffice page for bonuses',
    'an admin panel',
  ])('an ask naming a page, screen or dashboard is a ui-page: %s', (ask) => {
    expect(classifyIntent(ask)).toBe('ui-page');
  });

  it.each([
    'add an endpoint to list games',
    'a new route',
    'a procedure that closes accounts',
    'expose an rpc',
  ])('an ask naming an endpoint or route is a route: %s', (ask) => {
    expect(classifyIntent(ask)).toBe('route');
  });

  it.each([
    'add a weekly tournament',
    'a cashback scheme',
    'a new bonus',
    'leaderboard with rewards',
    'build a feature for missions',
  ])('an ask naming a feature, bonus or tournament is a feature: %s', (ask) => {
    expect(classifyIntent(ask)).toBe('feature');
  });

  it('adapter wins over ui-page when both are named', () => {
    expect(classifyIntent('a dashboard page for the payment gateway')).toBe('adapter');
  });

  it('ui-page wins over route and route wins over feature', () => {
    expect(classifyIntent('a page and an endpoint')).toBe('ui-page');
    expect(classifyIntent('an endpoint for the bonus')).toBe('route');
  });

  it('an ask matching nothing is unsure', () => {
    expect(classifyIntent('make it faster')).toBe('unsure');
    expect(classifyIntent('')).toBe('unsure');
  });

  it('matching is case-insensitive', () => {
    expect(classifyIntent('SWAP THE PAYMENT PROVIDER')).toBe('adapter');
    expect(classifyIntent('A New Dashboard')).toBe('ui-page');
    expect(classifyIntent('Add ENDPOINT')).toBe('route');
  });

  it('matching is whole-word', () => {
    expect(classifyIntent('payments overview')).toBe('unsure');
    expect(classifyIntent('review the code')).toBe('unsure');
    expect(classifyIntent('the viewport')).toBe('unsure');
    expect(classifyIntent('rerouted traffic')).toBe('unsure');
    expect(classifyIntent('bonuses')).toBe('unsure');
    expect(classifyIntent('a prepayment flow')).toBe('unsure');
    expect(classifyIntent('subscreen')).toBe('unsure');
    expect(classifyIntent('reroute')).toBe('unsure');
  });

  it('a keyword next to punctuation still matches', () => {
    expect(classifyIntent('add a (bonus)')).toBe('feature');
    expect(classifyIntent('stripe, please')).toBe('adapter');
  });
});
