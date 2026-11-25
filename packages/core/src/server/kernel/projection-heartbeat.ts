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
 * Calls `beat` now and every `LEDGER_PROJECTION_HEARTBEAT_MS` (default 10 s) until the container
 * is disposed (ADR-0062). Start it only where the owning module is selected (`mounted`), so a
 * process that merely binds the module's ports never claims the projection is fresh.
 */
export function startProjectionHeartbeat(
  beat: () => Promise<void>,
  onDispose: (dispose: () => void) => void,
  onError: (err: unknown) => void,
): void {
  const run = () => void beat().catch(onError);
  const timer = setInterval(run, envMs('LEDGER_PROJECTION_HEARTBEAT_MS', 10_000));
  timer.unref();
  onDispose(() => clearInterval(timer));
  run();
}
