import { randomUUID } from 'node:crypto';
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

describe('identity security event contracts', () => {
  it('accepts an authentication-success event only with a supported credential method', () => {
    const payload = {
      userId: randomUUID(),
      playerId: null,
      method: 'totp',
      ip: null,
      userAgent: null,
    };

    expect(domainEventSchemas['identity.authentication.succeeded'].safeParse(payload).success).toBe(
      true,
    );
    expect(
      domainEventSchemas['identity.authentication.succeeded'].safeParse({
        ...payload,
        method: 'session_refresh',
      }).success,
    ).toBe(false);
  });

  it('requires the before and after preference state for a login-withdrawal-alert change', () => {
    const payload = {
      userId: randomUUID(),
      playerId: randomUUID(),
      previousEnabled: false,
      enabled: true,
    };

    expect(
      domainEventSchemas['identity.security.login_withdrawal_alerts.updated'].safeParse(payload)
        .success,
    ).toBe(true);
    expect(
      domainEventSchemas['identity.security.login_withdrawal_alerts.updated'].safeParse({
        ...payload,
        previousEnabled: undefined,
      }).success,
    ).toBe(false);
  });
});

// ADR-0016 requires forward-compatible payload evolution, and every deployment binds a
// durable broker (ADR-0030/0032) - a pre-tiering (v4) compliance.kyc.* payload with no
// `tier` at all can still be sitting in the backlog at rollout. Basic-tier is what every
// payload meant before tiering existed, so a missing `tier` must default to it rather
// than fail the parse and drop the event.
describe('compliance.kyc.* tier forward-compat', () => {
  const topics = [
    'compliance.kyc.updated',
    'compliance.kyc.submitted',
    'compliance.kyc.reverify_required',
    'compliance.kyc.high_risk_signal_detected',
  ] as const;

  const basePayloads: Record<(typeof topics)[number], Record<string, unknown>> = {
    'compliance.kyc.updated': {
      userId: randomUUID(),
      playerId: null,
      actorId: null,
      status: 'approved',
      previousStatus: 'pending',
      reason: null,
      source: 'webhook',
    },
    'compliance.kyc.submitted': {
      userId: randomUUID(),
      playerId: null,
      referenceId: 'ref-1',
      provider: 'mock',
    },
    'compliance.kyc.reverify_required': {
      userId: randomUUID(),
      playerId: null,
      reason: 'threshold crossed',
    },
    'compliance.kyc.high_risk_signal_detected': {
      userId: randomUUID(),
      playerId: null,
      referenceId: 'ref-1',
      vpnOrTorDetected: false,
      dataCenterIpDetected: false,
      duplicateDeviceDetected: false,
      highRiskCountryDetected: false,
    },
  };

  it('defaults a payload with no tier field to basic, instead of failing the parse', () => {
    for (const topic of topics) {
      const result = domainEventSchemas[topic].safeParse(basePayloads[topic]);
      expect(result.success).toBe(true);
      expect(result.success && (result.data as { tier: string }).tier).toBe('basic');
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
