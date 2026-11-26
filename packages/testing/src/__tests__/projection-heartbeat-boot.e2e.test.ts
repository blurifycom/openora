import { afterEach, describe, expect, it, vi } from 'vitest';
import { BullMqJobQueue, DRIZZLE } from '@openora/core/server';
import { ledgerProjectionHeartbeat } from '@openora/core/wallet/schema';
import { bootWalletE2e, closeWalletE2e, type WalletE2e } from './support/wallet.js';

const HEARTBEAT_JOBS = ['identity-ledger-heartbeat', 'compliance-ledger-heartbeat'];
const ARMED_ENV = {
  INTERNAL_API_SECRETS: 'x'.repeat(32),
  MONEY_PORTS_CALLERS: 'platform',
  LEDGER_PROJECTION_HEARTBEAT_MS: '3600000',
};

let e2e: WalletE2e | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await closeWalletE2e(e2e);
  e2e = undefined;
});

async function bootObserving(env: Record<string, string>) {
  const scheduled: string[] = [];
  const original = BullMqJobQueue.prototype.schedule;
  vi.spyOn(BullMqJobQueue.prototype, 'schedule').mockImplementation(function (
    this: BullMqJobQueue,
    ...args: Parameters<BullMqJobQueue['schedule']>
  ) {
    scheduled.push(args[1]);
    return original.apply(this, args);
  });
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  e2e = await bootWalletE2e();
  return {
    jobs: () => scheduled.filter((id) => HEARTBEAT_JOBS.includes(id)).sort(),
    beats: async () => {
      const rows = await db()
        .select({ projection: ledgerProjectionHeartbeat.projection })
        .from(ledgerProjectionHeartbeat);
      return rows.map((row) => row.projection).sort();
    },
  };
}

function db() {
  if (!e2e) {
    throw new Error('app not booted');
  }
  return e2e.app.container.get(DRIZZLE).db;
}

describe('the projection heartbeat at boot', () => {
  it('schedules no heartbeat job and beats nothing in a monolith nothing arms', async () => {
    vi.stubEnv('MONEY_PORTS_CALLERS', '');

    const booted = await bootObserving({});

    expect(booted.jobs()).toEqual([]);
    expect(await booted.beats()).toEqual([]);
  });

  it('beats both projections at boot and schedules both jobs when money ports callers are set', async () => {
    const booted = await bootObserving(ARMED_ENV);

    expect(booted.jobs()).toEqual([...HEARTBEAT_JOBS].sort());
    await vi.waitFor(async () => {
      expect(await booted.beats()).toEqual(['play_eligibility', 'rg_limits']);
    });
  });
});
