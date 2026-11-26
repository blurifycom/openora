import { afterAll, describe, expect, it } from 'vitest';
import type { AuditWritePort, SwapAdapter, SwapQuote } from '@openora/core/contracts';
import { DrizzleService, type EventBus } from '@openora/core/server';
import { SwapPairUnsupportedError, SwapService } from '../swap.service.js';

const drizzle = new DrizzleService('postgres://unit:unit@127.0.0.1:1/unit');
afterAll(() => drizzle.dispose());

const idle: EventBus = {
  emit: () => undefined,
  emitRaw: () => undefined,
  emitInTransaction: async () => undefined,
  on: () => () => undefined,
  tapTransactional: () => undefined,
};

const audit: AuditWritePort = {
  record: async () => undefined,
  recordInTransaction: async () => undefined,
  recordManyInTransaction: async () => undefined,
};

const quoteFor = (fromCurrency: string, toCurrency: string): SwapQuote => ({
  quoteId: 'q-1',
  fromCurrency,
  toCurrency,
  fromAmount: '1',
  toAmount: '2',
  rate: '2',
  fee: '0',
  feeCurrency: toCurrency,
  asOf: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-01T00:00:30.000Z',
});

const desk = (over: Partial<SwapAdapter> = {}) => {
  const quoted: Array<[string, string]> = [];
  const adapter: SwapAdapter = {
    getQuote: async ({ fromCurrency, toCurrency }) => {
      quoted.push([fromCurrency, toCurrency]);
      return quoteFor(fromCurrency, toCurrency);
    },
    execute: async () => {
      throw new Error('execute must not be reached');
    },
    ...over,
  };
  return { service: new SwapService({ drizzle, events: idle, adapter, audit }), quoted };
};

const userId = '00000000-0000-4000-8000-000000000001';

describe('SwapService pair check', () => {
  it.each([
    ['USDT', 'USDT'],
    ['usdt', 'USDT'],
    ['Btc', 'bTC'],
  ])('refuses %s -> %s as the same balance before asking the desk', async (from, to) => {
    const { service, quoted } = desk();
    await expect(
      service.quote({ userId, fromCurrency: from, toCurrency: to, fromAmount: '1' }),
    ).rejects.toBeInstanceOf(SwapPairUnsupportedError);
    expect(quoted).toEqual([]);
  });

  it('refuses a same-balance swap before touching the database', async () => {
    const { service } = desk();
    await expect(
      service.swap({
        userId,
        fromCurrency: 'eth',
        toCurrency: 'ETH',
        fromAmount: '1',
        idempotencyKey: 'k-1',
      }),
    ).rejects.toBeInstanceOf(SwapPairUnsupportedError);
  });

  it('refuses a pair the desk says it does not support, before quoting', async () => {
    const asked: Array<[string, string]> = [];
    const { service, quoted } = desk({
      supportsPair: (from, to) => {
        asked.push([from, to]);
        return false;
      },
    });
    await expect(
      service.quote({ userId, fromCurrency: 'BTC', toCurrency: 'USDT', fromAmount: '1' }),
    ).rejects.toBeInstanceOf(SwapPairUnsupportedError);
    expect(asked).toEqual([['BTC', 'USDT']]);
    expect(quoted).toEqual([]);
  });

  it('quotes a supported pair of different balances', async () => {
    const { service, quoted } = desk({ supportsPair: () => true });
    await expect(
      service.quote({ userId, fromCurrency: 'BTC', toCurrency: 'USDT', fromAmount: '1' }),
    ).resolves.toMatchObject({ fromCurrency: 'BTC', toCurrency: 'USDT' });
    expect(quoted).toEqual([['BTC', 'USDT']]);
  });

  it('quotes any pair of different balances when the desk has no pair list', async () => {
    const { service, quoted } = desk();
    await service.quote({ userId, fromCurrency: 'USDC', toCurrency: 'USDT', fromAmount: '1' });
    expect(quoted).toEqual([['USDC', 'USDT']]);
  });

  it('refuses when the desk will not quote the pair', async () => {
    const { service } = desk({ getQuote: async () => null });
    await expect(
      service.quote({ userId, fromCurrency: 'BTC', toCurrency: 'USDT', fromAmount: '1' }),
    ).rejects.toBeInstanceOf(SwapPairUnsupportedError);
  });
});
