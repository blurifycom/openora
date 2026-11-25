import { afterEach, describe, expect, it, vi } from 'vitest';
import { ORPCError } from '@orpc/server';
import {
  MONEY_PORTS_ROUTE,
  LedgerProjectionStaleError,
  RgRateUnavailableError,
  decodeMoneyWire,
  encodeMoneyWire,
  moneyPortErrorWireOf,
  type PlayEligibilityProjectionPort,
  type RgLimitLedgerPort,
  type WalletReader,
} from '@openora/core/contracts';
import { createInternalClient, InternalApiError, type InternalClient } from '@openora/core/server';
import { remoteMoneyPort } from '../service/remote-money-port.service.js';

type Sent = {
  method: string;
  path: string;
  body: { method: string; args: string };
};

function scripted(replies: (() => unknown)[]) {
  const sent: Sent[] = [];
  const client: InternalClient = {
    async request(method, path, body) {
      sent.push({ method, path, body: body as Sent['body'] });
      const next = replies.shift();
      if (!next) {
        throw new Error('no reply scripted');
      }
      return next();
    },
  };
  return { client, sent };
}

const answer = (value: unknown) => () => ({ result: encodeMoneyWire(value) });
const fail = (kind: 'timeout' | 'network' | 'client' | 'server') => () => {
  throw new InternalApiError(kind, kind, kind === 'client' ? { status: 403 } : {});
};
const settle = (promise: Promise<unknown>) => promise.catch((err: unknown) => err);
const snapshot = {
  userId: '00000000-0000-4000-8000-000000000001',
  rgBlocked: true,
  rgBlockedUntil: null,
  isActive: true,
  banned: false,
  banExpires: null,
  status: null,
  version: 3,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('money wire codec', () => {
  it('keeps dates, maps and an omitted argument across the wire', () => {
    const at = new Date('2026-11-25T10:00:00.000Z');
    const decoded = decodeMoneyWire(encodeMoneyWire(['u1', undefined, at, new Map([['a', at]])]));
    expect(decoded).toEqual(['u1', undefined, at, new Map([['a', at]])]);
    expect(decodeMoneyWire(encodeMoneyWire(undefined))).toBeUndefined();
  });

  it('refuses a reply that is not one wrapped value', () => {
    expect(() => decodeMoneyWire('{"result":1}')).toThrow(/not a money wire value/);
  });
});

describe('remoteMoneyPort', () => {
  it('sends a read without its transaction and decodes the answer', async () => {
    const { client, sent } = scripted([answer('42.00'), answer(true)]);
    const reader = remoteMoneyPort<WalletReader>(client, 'WALLET_READER');

    expect(await reader.getLifetimeDeposit('u1', { a: 'caller tx' })).toBe('42.00');
    expect(await reader.hasWallet('u1', { a: 'caller tx' })).toBe(true);

    expect(sent.map((s) => [s.path, s.body.method, decodeMoneyWire(s.body.args)])).toEqual([
      [MONEY_PORTS_ROUTE, 'getLifetimeDeposit', ['u1']],
      [MONEY_PORTS_ROUTE, 'hasWallet', ['u1']],
    ]);
  });

  it('marks the projection writers remote, so ADR-0062 applies', () => {
    const { client } = scripted([]);
    expect(
      remoteMoneyPort<PlayEligibilityProjectionPort>(client, 'PLAY_ELIGIBILITY_PROJECTION').remote,
    ).toBe(true);
    expect(remoteMoneyPort<WalletReader>(client, 'WALLET_READER')).not.toHaveProperty('remote');
  });

  it('retries a write once, with the same body, after a timeout', async () => {
    const { client, sent } = scripted([fail('timeout'), answer(undefined)]);
    const projection = remoteMoneyPort<PlayEligibilityProjectionPort>(
      client,
      'PLAY_ELIGIBILITY_PROJECTION',
    );

    await projection.write(snapshot, { a: 'caller tx' });

    expect(sent).toHaveLength(2);
    expect(sent[1]?.body).toEqual(sent[0]?.body);
    expect(decodeMoneyWire(sent[0]?.body.args ?? '')).toEqual([snapshot]);
  });

  it('fails closed when the retry fails too, and never tries a third time', async () => {
    const { client, sent } = scripted([fail('network'), fail('server'), answer(undefined)]);
    const projection = remoteMoneyPort<PlayEligibilityProjectionPort>(
      client,
      'PLAY_ELIGIBILITY_PROJECTION',
    );

    const err = await settle(projection.heartbeat());

    expect(err).toBeInstanceOf(ORPCError);
    expect((err as ORPCError<string, unknown>).code).toBe('SERVICE_UNAVAILABLE');
    expect(sent).toHaveLength(2);
  });

  it('does not retry a refused write or any read', async () => {
    const refused = scripted([fail('client'), answer(undefined)]);
    const projection = remoteMoneyPort<PlayEligibilityProjectionPort>(
      refused.client,
      'PLAY_ELIGIBILITY_PROJECTION',
    );
    expect(await settle(projection.heartbeat())).toBeInstanceOf(InternalApiError);
    expect(refused.sent).toHaveLength(1);

    const read = scripted([fail('timeout'), answer('1')]);
    const reader = remoteMoneyPort<WalletReader>(read.client, 'WALLET_READER');
    expect(await settle(reader.getLifetimeDeposit('u1'))).toBeInstanceOf(ORPCError);
    expect(read.sent).toHaveLength(1);
  });

  it('rethrows a typed port error as its own class, and never retries it', async () => {
    const typed = (err: Error) => () => {
      throw new InternalApiError('client', '422', {
        status: 422,
        body: { code: 'UNPROCESSABLE_CONTENT', data: moneyPortErrorWireOf(err) },
      });
    };
    const lastBeatAt = new Date('2026-11-25T10:00:00.000Z');
    const { client, sent } = scripted([
      typed(new RgRateUnavailableError('deposit', 'daily', 'EUR', 'USD')),
      typed(new LedgerProjectionStaleError('rg_limits', lastBeatAt)),
      answer(undefined),
    ]);
    const ledger = remoteMoneyPort<RgLimitLedgerPort>(client, 'RG_LIMIT_LEDGER');

    const rate = await settle(ledger.spendFor({}, 'u1', 'deposit', 'daily', lastBeatAt, 'USD'));
    expect(rate).toBeInstanceOf(RgRateUnavailableError);
    expect(rate).toMatchObject({ limitType: 'deposit', period: 'daily', missingCurrency: 'EUR' });
    const stale = await settle(ledger.heartbeat());
    expect(stale).toBeInstanceOf(LedgerProjectionStaleError);
    expect(stale).toMatchObject({ projection: 'rg_limits', lastBeatAt });
    expect(sent).toHaveLength(2);
  });

  it('reads a 422 that carries no typed error as a refused call', async () => {
    const { client } = scripted([
      () => {
        throw new InternalApiError('client', '422', { status: 422, body: { data: { code: 'x' } } });
      },
    ]);
    const reader = remoteMoneyPort<WalletReader>(client, 'WALLET_READER');
    expect(await settle(reader.getBalances('u1'))).toBeInstanceOf(InternalApiError);
  });

  it('throws on a reply that does not parse rather than reading it as an answer', async () => {
    const { client } = scripted([() => ({ result: 42 })]);
    const reader = remoteMoneyPort<WalletReader>(client, 'WALLET_READER');
    await expect(reader.getBalances('u1')).rejects.toThrow();
  });

  it('fails closed with a 503 when the money service does not answer in time', async () => {
    const fetch = vi.fn(
      (_url: URL, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const client = createInternalClient({
      baseUrl: 'http://money.test',
      serviceName: 'platform',
      audience: 'money',
      secrets: 'x'.repeat(32),
      timeoutMs: 20,
    });
    const reader = remoteMoneyPort<WalletReader>(client, 'WALLET_READER');

    const err = await settle(reader.getBalances('u1'));

    expect(err).toBeInstanceOf(ORPCError);
    expect((err as ORPCError<string, unknown>).code).toBe('SERVICE_UNAVAILABLE');
    expect(((err as Error).cause as InternalApiError).kind).toBe('timeout');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
