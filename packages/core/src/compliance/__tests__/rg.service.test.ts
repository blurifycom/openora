import { describe, it, expect, vi } from 'vitest';
import type { DrizzleService } from '@openora/core/server';
import type { LoginEnforcementPort } from '@openora/core/contracts';
import { mock, mockDb } from '../../testing/mock.js';
import { userLimit, rgExclusion } from '../schema/index.js';
import {
  RgService,
  ActiveExclusionError,
  PermanentExclusionLiftError,
  ExclusionPeriodNotElapsedError,
  ExclusionNotFoundError,
} from '../service/rg.service.js';

// Routing Drizzle stub. `select().from(t)` resolves the next value from that table's
// queue (so the pre-write check and the enforcement recompute get distinct rows);
// `transaction(cb)` runs inline; `insert`/`update` `.returning()` yield `returning`.
function routingDb(cfg: {
  rgExclusion?: unknown[];
  userLimit?: unknown[];
  returning?: unknown;
}): DrizzleService {
  const queues = new Map<unknown, unknown[]>([
    [rgExclusion, [...(cfg.rgExclusion ?? [])]],
    [userLimit, [...(cfg.userLimit ?? [])]],
  ]);
  function selectChain() {
    let table: unknown;
    const c: Record<string, unknown> = {
      from: (t: unknown) => {
        table = t;
        return c;
      },
      innerJoin: () => c,
      where: () => c,
      orderBy: () => c,
      limit: () => c,
      offset: () => c,
      then: (resolve: (v: unknown) => unknown) => {
        const q = queues.get(table);
        resolve(q && q.length > 0 ? q.shift() : []);
      },
    };
    return c;
  }
  const returning = () => Promise.resolve(cfg.returning ?? []);
  const db: Record<string, unknown> = {
    transaction: (cb: (tx: unknown) => unknown) => cb(db),
    select: () => selectChain(),
    insert: () => {
      const c: Record<string, unknown> = {
        values: () => c,
        onConflictDoUpdate: () => c,
        returning,
        then: (r: (v: unknown) => unknown) => r(undefined),
      };
      return c;
    },
    update: () => {
      const c: Record<string, unknown> = {
        set: () => c,
        where: () => c,
        returning,
        then: (r: (v: unknown) => unknown) => r(undefined),
      };
      return c;
    },
  };
  return mockDb(db);
}

function makeEvents() {
  return { emit: vi.fn(), on: vi.fn() };
}

function makeEnforcement(): LoginEnforcementPort {
  return {
    block: vi.fn().mockResolvedValue(undefined),
    unblock: vi.fn().mockResolvedValue(undefined),
  };
}

function newSvc(db: DrizzleService, enforcement = makeEnforcement(), events = makeEvents()) {
  const svc = new RgService({
    drizzle: db,
    events: mock(events),
    loginEnforcement: enforcement,
    email: null,
    directory: null,
  });
  return { svc, events, enforcement };
}

function exclusionRow(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: 'excl-1',
    userId: 'user-1',
    kind: 'self_exclusion',
    status: 'active',
    reason: 'gambling concern',
    isPermanent: false,
    startsAt: now,
    expiresAt: null,
    liftedAt: null,
    liftedReason: null,
    liftedBy: null,
    createdBy: 'admin-1',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const USER = 'user-1';
const ADMIN = 'admin-1';
const future = () => new Date(Date.now() + 200 * 24 * 3600_000);

describe('RgService.setPlayerLimit', () => {
  it('emits rg.limit.set with the prior amount and returns the DTO', async () => {
    const row = {
      id: 'lim-1',
      userId: USER,
      type: 'deposit',
      amount: '100',
      minutes: null,
      period: 'daily',
      createdAt: new Date(),
    };
    const { svc, events } = newSvc(
      routingDb({ userLimit: [[{ amount: '50', minutes: null }]], returning: [row] }),
    );
    const dto = await svc.setPlayerLimit(
      USER,
      { userId: USER, type: 'deposit', amount: '100', minutes: null, period: 'daily' },
      ADMIN,
    );
    expect(dto.id).toBe('lim-1');
    expect(events.emit).toHaveBeenCalledWith(
      'rg.limit.set',
      expect.objectContaining({
        userId: USER,
        actorId: ADMIN,
        amount: '100',
        previousAmount: '50',
      }),
    );
  });
});

describe('RgService.activateCoolingOff', () => {
  it('blocks login until the expiry and emits the activation event', async () => {
    const row = exclusionRow({ kind: 'cooling_off', expiresAt: future() });
    const db = routingDb({
      rgExclusion: [[], [{ kind: 'cooling_off', expiresAt: future() }]],
      returning: [row],
    });
    const { svc, events, enforcement } = newSvc(db);
    await svc.activateCoolingOff(USER, { userId: USER, durationHours: 24, reason: 'break' }, ADMIN);
    expect(enforcement.block).toHaveBeenCalledWith(USER, { until: expect.any(Date) });
    expect(enforcement.unblock).not.toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalledWith(
      'rg.cooling_off.activated',
      expect.objectContaining({ userId: USER }),
    );
  });

  it('rejects when an active cooling-off already exists', async () => {
    const { svc, enforcement } = newSvc(routingDb({ rgExclusion: [[{ id: 'x' }]] }));
    await expect(
      svc.activateCoolingOff(USER, { userId: USER, durationHours: 24, reason: 'break' }, ADMIN),
    ).rejects.toBeInstanceOf(ActiveExclusionError);
    expect(enforcement.block).not.toHaveBeenCalled();
  });

  // GROUP 1: a cooling-off on a self-excluded player must NOT downgrade the hard block.
  it('keeps an indefinite block when a self-exclusion is still active', async () => {
    const row = exclusionRow({ kind: 'cooling_off', expiresAt: future() });
    const db = routingDb({
      rgExclusion: [
        [],
        [
          { kind: 'self_exclusion', expiresAt: null },
          { kind: 'cooling_off', expiresAt: future() },
        ],
      ],
      returning: [row],
    });
    const { svc, enforcement } = newSvc(db);
    await svc.activateCoolingOff(USER, { userId: USER, durationHours: 24, reason: 'break' }, ADMIN);
    expect(enforcement.block).toHaveBeenCalledWith(USER, { until: null });
  });
});

describe('RgService.activateSelfExclusion', () => {
  it('blocks indefinitely (until null) for a permanent exclusion', async () => {
    const row = exclusionRow({ isPermanent: true, expiresAt: null });
    const db = routingDb({
      rgExclusion: [[], [{ kind: 'self_exclusion', expiresAt: null }]],
      returning: [row],
    });
    const { svc, events, enforcement } = newSvc(db);
    await svc.activateSelfExclusion(
      USER,
      { userId: USER, isPermanent: true, reason: 'stop', confirm: true },
      ADMIN,
    );
    expect(enforcement.block).toHaveBeenCalledWith(USER, { until: null });
    expect(events.emit).toHaveBeenCalledWith(
      'rg.self_exclusion.activated',
      expect.objectContaining({ isPermanent: true, expiresAt: null }),
    );
  });
});

describe('RgService.liftSelfExclusion', () => {
  it('rejects lifting a permanent self-exclusion', async () => {
    const db = routingDb({ rgExclusion: [[exclusionRow({ isPermanent: true, expiresAt: null })]] });
    const { svc, enforcement } = newSvc(db);
    await expect(
      svc.liftSelfExclusion(USER, { userId: USER, reason: 'ok', confirm: true }, ADMIN),
    ).rejects.toBeInstanceOf(PermanentExclusionLiftError);
    expect(enforcement.unblock).not.toHaveBeenCalled();
  });

  it('rejects lifting before the minimum period elapses', async () => {
    const db = routingDb({
      rgExclusion: [[exclusionRow({ isPermanent: false, expiresAt: future() })]],
    });
    const { svc } = newSvc(db);
    await expect(
      svc.liftSelfExclusion(USER, { userId: USER, reason: 'ok', confirm: true }, ADMIN),
    ).rejects.toBeInstanceOf(ExclusionPeriodNotElapsedError);
  });

  it('rejects when there is no active self-exclusion', async () => {
    const { svc } = newSvc(routingDb({ rgExclusion: [[]] }));
    await expect(
      svc.liftSelfExclusion(USER, { userId: USER, reason: 'ok', confirm: true }, ADMIN),
    ).rejects.toBeInstanceOf(ExclusionNotFoundError);
  });

  it('lifts after the minimum period and unblocks when nothing else is active', async () => {
    const past = new Date(Date.now() - 1000);
    const existing = exclusionRow({ isPermanent: false, expiresAt: past });
    const lifted = { ...existing, status: 'lifted' };
    const db = routingDb({ rgExclusion: [[existing], []], returning: [lifted] });
    const { svc, events, enforcement } = newSvc(db);
    await svc.liftSelfExclusion(USER, { userId: USER, reason: 'ok', confirm: true }, ADMIN);
    expect(enforcement.unblock).toHaveBeenCalledWith(USER);
    expect(events.emit).toHaveBeenCalledWith(
      'rg.self_exclusion.lifted',
      expect.objectContaining({ userId: USER }),
    );
  });

  // GROUP 1: lifting the self-exclusion must not clear an unrelated active cooling-off.
  it('recomputes to the remaining cooling-off block instead of unblocking', async () => {
    const past = new Date(Date.now() - 1000);
    const existing = exclusionRow({ isPermanent: false, expiresAt: past });
    const db = routingDb({
      rgExclusion: [[existing], [{ kind: 'cooling_off', expiresAt: future() }]],
      returning: [{ ...existing, status: 'lifted' }],
    });
    const { svc, enforcement } = newSvc(db);
    await svc.liftSelfExclusion(USER, { userId: USER, reason: 'ok', confirm: true }, ADMIN);
    expect(enforcement.block).toHaveBeenCalledWith(USER, { until: expect.any(Date) });
    expect(enforcement.unblock).not.toHaveBeenCalled();
  });
});
