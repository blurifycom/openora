import { describe, it, expect } from 'vitest';
import {
  getEventVersion,
  eventCatalog,
  domainEventVersions,
  domainEventSchemas,
  DOMAIN_EVENT_CATALOG,
} from '../events.js';

describe('getEventVersion', () => {
  it('defaults an unversioned topic to 1', () => {
    expect(getEventVersion('cms.page.created')).toBe(1);
  });

  it('returns the pinned version for a topic that has been bumped', () => {
    expect(getEventVersion('wallet.deposit.completed')).toBe(2);
    expect(getEventVersion('compliance.kyc.updated')).toBe(5);
  });

  it('defaults an unknown topic to 1 rather than throwing', () => {
    expect(getEventVersion('tournaments.leaderboard.settled')).toBe(1);
  });
});

describe('domainEventVersions', () => {
  it('only pins topics that actually exist', () => {
    for (const topic of Object.keys(domainEventVersions)) {
      expect(DOMAIN_EVENT_CATALOG).toContain(topic);
    }
  });

  it('never pins a version below the implicit default', () => {
    for (const version of Object.values(domainEventVersions)) {
      expect(version).toBeGreaterThan(1);
    }
  });

  it('pins whole numbers only - the broker treats the version as a discrete generation', () => {
    for (const version of Object.values(domainEventVersions)) {
      expect(Number.isInteger(version)).toBe(true);
    }
  });
});

describe('eventCatalog', () => {
  it('covers every declared payload schema', () => {
    expect(eventCatalog().map((e) => e.topic)).toEqual(Object.keys(domainEventSchemas));
  });

  it('carries no duplicate topics - a consumer group is keyed by topic', () => {
    const topics = eventCatalog().map((e) => e.topic);

    expect(new Set(topics).size).toBe(topics.length);
  });

  it('agrees with getEventVersion for every topic', () => {
    for (const { topic, version } of eventCatalog()) {
      expect(version).toBe(getEventVersion(topic));
    }
  });

  it('namespaces every topic by its owning module', () => {
    for (const { topic } of eventCatalog()) {
      expect(topic).toMatch(/^[a-z][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)+$/);
    }
  });
});
