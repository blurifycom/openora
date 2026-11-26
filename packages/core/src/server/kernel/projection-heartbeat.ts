import { parseInternalCallers } from './router-utils.js';

export function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const ms = Number(raw);
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw new Error(`${name} must be a positive number of milliseconds, got "${raw}"`);
  }
  return ms;
}

export const projectionHeartbeatEveryMs = (): number =>
  envMs('LEDGER_PROJECTION_HEARTBEAT_MS', 10_000);

export const projectionHeartbeatArmed = (remote: boolean | undefined): boolean =>
  remote === true || parseInternalCallers(process.env['MONEY_PORTS_CALLERS']).size > 0;
