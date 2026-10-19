import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isTelemetryEnabled, sendTelemetry, type TelemetryBody } from '../telemetry.js';

const PRODUCTION = { NODE_ENV: 'production' };

const body: TelemetryBody = {
  type: 'event',
  payload: {
    website: 'site',
    hostname: 'instance',
    url: '/heartbeat',
    name: 'heartbeat',
    id: 'instance-1',
    data: {
      version: '1.0.0',
      node: 'v22.0.0',
      os: 'linux',
      arch: 'x64',
      activePlayers1d: 1,
      activePlayers30d: 2,
    },
  },
};

describe('isTelemetryEnabled', () => {
  it('is on by default outside tests', () => {
    expect(isTelemetryEnabled(undefined, PRODUCTION)).toBe(true);
    expect(isTelemetryEnabled(undefined, {})).toBe(true);
  });

  it('is off when createApp is given telemetry: false', () => {
    expect(isTelemetryEnabled(false, PRODUCTION)).toBe(false);
  });

  it.each(['1', 'true', 'TRUE', ' yes '])('is off when OPENORA_TELEMETRY_DISABLED=%s', (flag) => {
    expect(isTelemetryEnabled(undefined, { ...PRODUCTION, OPENORA_TELEMETRY_DISABLED: flag })).toBe(
      false,
    );
  });

  it.each(['0', 'false', ''])('stays on when OPENORA_TELEMETRY_DISABLED=%s', (flag) => {
    expect(isTelemetryEnabled(undefined, { ...PRODUCTION, OPENORA_TELEMETRY_DISABLED: flag })).toBe(
      true,
    );
  });

  it('is off when DO_NOT_TRACK=1', () => {
    expect(isTelemetryEnabled(undefined, { ...PRODUCTION, DO_NOT_TRACK: '1' })).toBe(false);
  });

  it('is off under NODE_ENV=test', () => {
    expect(isTelemetryEnabled(undefined, { NODE_ENV: 'test' })).toBe(false);
  });

  it('is off when CI is set', () => {
    expect(isTelemetryEnabled(undefined, { ...PRODUCTION, CI: 'true' })).toBe(false);
  });
});

describe('sendTelemetry', () => {
  let server: Server;
  let url: string;
  let status = 200;
  const received: Array<{ headers: Record<string, unknown>; body: unknown }> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString();
      });
      req.on('end', () => {
        received.push({ headers: req.headers, body: JSON.parse(raw) });
        res.writeHead(status).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/send`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    received.length = 0;
    status = 200;
  });

  it('posts the event as JSON under a user agent Umami does not drop as a bot', async () => {
    await sendTelemetry(url, body);

    expect(received).toHaveLength(1);
    expect(received[0]?.body).toEqual(body);
    expect(received[0]?.headers['user-agent']).toMatch(
      /^Mozilla\/5\.0 \(compatible; openora\/\d+\.\d+\.\d+/,
    );
    expect(received[0]?.headers['content-type']).toBe('application/json');
  });

  it('rejects when the collector answers with an error status', async () => {
    status = 503;

    await expect(sendTelemetry(url, body)).rejects.toThrow('503');
  });
});
