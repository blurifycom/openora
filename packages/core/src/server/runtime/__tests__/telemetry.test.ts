import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CACHE,
  JOB_QUEUE,
  PLAYER_ACTIVITY_TRACKER,
  type CacheAdapter,
  type JobQueueAdapter,
  type PlayerActivityTracker,
} from '@openora/core/contracts';
import { DRIZZLE, type DrizzleService } from '../../db/index.js';
import { Container } from '../../kernel/index.js';
import type { CoreTokenCatalog } from '../core-token-catalog.js';
import { startTelemetry } from '../telemetry.js';

const INSTANCE_ID = '7b0f3c0e-8f43-4d5e-9d0b-1f6f0a7a2c11';
const DAY_MS = 24 * 60 * 60 * 1000;

type Rig = {
  container: Container<CoreTokenCatalog>;
  queue: {
    schedule: ReturnType<typeof vi.fn>;
    unschedule: ReturnType<typeof vi.fn>;
    registerWorker: ReturnType<typeof vi.fn>;
  };
  setIfAbsent: ReturnType<typeof vi.fn>;
};

function rig(
  options: {
    tracker?: boolean;
    scheduleFails?: boolean;
    firstBoot?: boolean;
  } = {},
): Rig {
  const { tracker = true, scheduleFails = false, firstBoot = true } = options;
  const schedule = vi.fn(async () => {
    if (scheduleFails) {
      throw new Error('redis down');
    }
  });
  const unschedule = vi.fn(async () => {});
  const registerWorker = vi.fn();
  const jobQueue: JobQueueAdapter = {
    enqueue: async () => ({ id: 'job' }),
    schedule,
    unschedule,
    registerWorker,
    close: async () => {},
  };
  const setIfAbsent = vi.fn(async () => firstBoot);
  const cache: CacheAdapter = {
    get: async () => undefined,
    set: async () => {},
    setIfAbsent,
    delete: async () => {},
  };
  const activity: PlayerActivityTracker = {
    touchLastSeen: async () => {},
    countActiveSince: async () => 3,
  };
  const db = {
    insert: () => ({ values: () => ({ onConflictDoNothing: async () => {} }) }),
    select: () => ({ from: async () => [{ instanceId: INSTANCE_ID }] }),
  };
  const drizzle: DrizzleService = Object.create({ db });
  const container = new Container<CoreTokenCatalog>();
  container.register(JOB_QUEUE, () => jobQueue);
  container.register(CACHE, () => cache);
  container.register(DRIZZLE, () => drizzle);
  if (tracker) {
    container.register(PLAYER_ACTIVITY_TRACKER, () => activity);
  }
  return { container, queue: { schedule, unschedule, registerWorker }, setIfAbsent };
}

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function okFetch() {
  return stubFetch(async () => new Response(null, { status: 204 }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('startTelemetry', () => {
  it('schedules nothing when telemetry is disabled in the option', () => {
    const fetchMock = okFetch();
    const { container, queue } = rig();
    startTelemetry(container, false, {});
    expect(queue.schedule).not.toHaveBeenCalled();
    expect(queue.registerWorker).not.toHaveBeenCalled();
    expect(queue.unschedule).toHaveBeenCalledWith('telemetry', 'telemetry.heartbeat');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['OPENORA_TELEMETRY_DISABLED', '1'],
    ['OPENORA_TELEMETRY_DISABLED', 'true'],
    ['OPENORA_TELEMETRY_DISABLED', ' YES '],
    ['DO_NOT_TRACK', '1'],
    ['DO_NOT_TRACK', 'true'],
  ])('schedules nothing when %s=%j is truthy', (name, value) => {
    const fetchMock = okFetch();
    const { container, queue } = rig();
    startTelemetry(container, undefined, { [name]: value });
    expect(queue.schedule).not.toHaveBeenCalled();
    expect(queue.registerWorker).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a falsy opt-out value does not disable telemetry', () => {
    okFetch();
    const { container, queue } = rig();
    startTelemetry(container, undefined, { DO_NOT_TRACK: '0' });
    expect(queue.schedule).toHaveBeenCalledTimes(1);
  });

  it('schedules nothing in CI or under NODE_ENV test', () => {
    const fetchMock = okFetch();
    const ci = rig();
    startTelemetry(ci.container, undefined, { CI: 'true' });
    expect(ci.queue.schedule).not.toHaveBeenCalled();
    expect(ci.queue.registerWorker).not.toHaveBeenCalled();

    const test = rig();
    startTelemetry(test.container, undefined, { NODE_ENV: 'test' });
    expect(test.queue.schedule).not.toHaveBeenCalled();
    expect(test.queue.registerWorker).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('schedules nothing on a service that cannot count players', () => {
    const fetchMock = okFetch();
    const { container, queue } = rig({ tracker: false });
    startTelemetry(container, undefined, {});
    expect(queue.schedule).not.toHaveBeenCalled();
    expect(queue.registerWorker).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('schedules a heartbeat job and reports boot when enabled', async () => {
    const fetchMock = okFetch();
    const { container, queue } = rig();
    startTelemetry(container, undefined, {});
    expect(queue.registerWorker).toHaveBeenCalledTimes(1);
    expect(queue.schedule).toHaveBeenCalledWith(
      'telemetry',
      'telemetry.heartbeat',
      {},
      { everyMs: DAY_MS },
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://telemetry.openora.ai/api/send');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body)).payload.name).toBe('boot');
  });

  it('does not report boot when another instance already holds the boot guard', async () => {
    const fetchMock = okFetch();
    const { container, setIfAbsent } = rig({ firstBoot: false });
    startTelemetry(container, undefined, {});
    await vi.waitFor(() => expect(setIfAbsent).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends to OPENORA_TELEMETRY_URL when set', async () => {
    const fetchMock = okFetch();
    const { container } = rig();
    startTelemetry(container, undefined, { OPENORA_TELEMETRY_URL: 'https://sink.example/api' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://sink.example/api');
  });

  it('the scheduled heartbeat worker reports a heartbeat event', async () => {
    const fetchMock = okFetch();
    const { container, queue } = rig({ firstBoot: false });
    startTelemetry(container, undefined, {});
    const registration = queue.registerWorker.mock.calls[0]?.[0];
    await registration.handler();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).payload.name).toBe('heartbeat');
  });

  it('boot completes when the telemetry endpoint is unreachable', async () => {
    const fetchMock = stubFetch(async () => {
      throw new TypeError('fetch failed');
    });
    const { container, queue } = rig();
    expect(() => startTelemetry(container, undefined, {})).not.toThrow();
    expect(queue.schedule).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it('boot completes when the endpoint answers an error status', async () => {
    const fetchMock = stubFetch(async () => new Response(null, { status: 500 }));
    const { container } = rig();
    expect(() => startTelemetry(container, undefined, {})).not.toThrow();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it('boot completes when the telemetry endpoint hangs past the send timeout', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = stubFetch(() => new Promise<Response>(() => {}));
    const { container, queue } = rig();
    const returned = startTelemetry(container, undefined, {});
    expect(returned).toBeUndefined();
    expect(queue.schedule).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(timeoutSpy).toHaveBeenCalledWith(5000);
    expect(fetchMock.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
  });

  it('a failed schedule is logged and does not throw', async () => {
    okFetch();
    const { container, queue } = rig({ scheduleFails: true });
    expect(() => startTelemetry(container, undefined, {})).not.toThrow();
    await vi.waitFor(() => expect(queue.schedule).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it('the payload carries no player or operator identifying data', async () => {
    const fetchMock = okFetch();
    const { container } = rig();
    startTelemetry(container, undefined, {});
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const init = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(init?.body));
    expect(Object.keys(body).sort()).toEqual(['payload', 'type']);
    expect(Object.keys(body.payload).sort()).toEqual([
      'data',
      'hostname',
      'id',
      'name',
      'url',
      'website',
    ]);
    expect(Object.keys(body.payload.data).sort()).toEqual([
      'activePlayers1d',
      'activePlayers30d',
      'arch',
      'node',
      'os',
      'version',
    ]);
    expect(body.payload.id).toBe(INSTANCE_ID);
    expect(body.payload.hostname).toBe('instance');
    expect(body.payload.data.activePlayers1d).toBe(3);
    expect(JSON.stringify(init?.headers)).not.toMatch(/authorization|cookie/i);
  });
});
