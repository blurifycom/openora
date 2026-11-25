/**
 * A positive whole number of milliseconds from `name`, or `fallback` when unset. A value that is
 * not one fails the boot rather than silently running with a default nobody chose.
 */
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

/**
 * How often an owner beats its ledger projection: `LEDGER_PROJECTION_HEARTBEAT_MS`, default 10 s
 * (ADR-0062). The owner schedules one recurring job at this interval where its module is selected,
 * so one replica beats per tick, never every one.
 */
export const projectionHeartbeatEveryMs = (): number =>
  envMs('LEDGER_PROJECTION_HEARTBEAT_MS', 10_000);
