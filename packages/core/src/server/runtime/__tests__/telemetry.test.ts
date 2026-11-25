import { describe, it } from 'vitest';

describe('startTelemetry', () => {
  it.todo('schedules nothing when telemetry is disabled in the option');
  it.todo(
    'schedules nothing when OPENORA_TELEMETRY_DISABLED or DO_NOT_TRACK is set to a truthy value',
  );
  it.todo('schedules nothing in CI or under NODE_ENV test');
  it.todo('schedules a heartbeat job and reports boot when enabled');
  it.todo('boot completes when the telemetry endpoint is unreachable');
  it.todo('boot completes when the telemetry endpoint hangs past the send timeout');
  it.todo('a failed schedule is logged and does not throw');
  it.todo('the payload carries no player or operator identifying data');
});
