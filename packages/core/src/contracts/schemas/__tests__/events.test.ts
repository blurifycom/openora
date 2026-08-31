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
    expect(getEventVersion('compliance.kyc.updated')).toBe(4);
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

describe('event currency fields accept a wallet/gaming money ticker', () => {
  const walletDeposit = {
    userId: crypto.randomUUID(),
    playerId: null,
    amount: '10.00',
    currency: 'USDT',
    transactionId: crypto.randomUUID(),
  };
  const gamingRoundStarted = {
    roundId: crypto.randomUUID(),
    gameId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    playerId: null,
    currency: 'USDT',
  };
  const bonusRolloverCompleted = {
    userId: crypto.randomUUID(),
    creditId: crypto.randomUUID(),
    currency: 'USDT',
    creditedAmount: '10.00',
  };

  it('accepts a 4-character ticker on wallet.deposit.completed', () => {
    expect(domainEventSchemas['wallet.deposit.completed'].safeParse(walletDeposit).success).toBe(
      true,
    );
  });

  it('accepts a 4-character ticker on gaming.round.started', () => {
    expect(domainEventSchemas['gaming.round.started'].safeParse(gamingRoundStarted).success).toBe(
      true,
    );
  });

  it('accepts a 4-character ticker on wallet.bonus_rollover.completed', () => {
    expect(
      domainEventSchemas['wallet.bonus_rollover.completed'].safeParse(bonusRolloverCompleted)
        .success,
    ).toBe(true);
  });

  it('still rejects an obviously invalid currency value', () => {
    const invalid = { ...walletDeposit, currency: '123' };

    expect(domainEventSchemas['wallet.deposit.completed'].safeParse(invalid).success).toBe(false);
  });
});
