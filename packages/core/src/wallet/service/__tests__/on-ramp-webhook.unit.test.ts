import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fillsDeliveryDetails, webhookMismatch } from '../on-ramp.service.js';

type Order = Parameters<typeof webhookMismatch>[0];
type Event = Parameters<typeof webhookMismatch>[1];

const USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const ADDRESS = 'rPlayerDepositAddress111';

const order = (over: Partial<Order>): Order => ({
  id: '33333333-3333-4333-8333-333333333333',
  userId: USER_ID,
  externalId: null,
  idempotencyKey: '44444444-4444-4444-8444-444444444444',
  checkoutUrl: null,
  expiresAt: null,
  fiatAmount: '100.00000000',
  fiatCurrency: 'EUR',
  currency: 'XRP',
  network: 'XRP',
  walletAddress: ADDRESS,
  walletTag: null,
  status: 'pending',
  cryptoAmount: null,
  txHash: null,
  gatewayId: null,
  createdAt: new Date('2026-03-01T00:00:00.000Z'),
  updatedAt: new Date('2026-03-01T00:00:00.000Z'),
  ...over,
});

const event = (over: Partial<Event>): Event => ({
  externalId: 'vendor-order-1',
  status: 'processing',
  ...over,
});

describe('webhookMismatch', () => {
  it.each([
    ['no identifying fields', event({}), order({}), null],
    [
      'matching customer and wallet',
      event({ externalCustomerId: USER_ID, walletAddress: ADDRESS }),
      order({}),
      null,
    ],
    ['another customer', event({ externalCustomerId: OTHER_USER_ID }), order({}), 'customer'],
    ['empty customer id', event({ externalCustomerId: '' }), order({}), 'customer'],
    [
      'customer id in upper case',
      event({ externalCustomerId: USER_ID.toUpperCase() }),
      order({}),
      'customer',
    ],
    ['another address', event({ walletAddress: 'rAttackerAddress' }), order({}), 'wallet'],
    ['address with trailing space', event({ walletAddress: `${ADDRESS} ` }), order({}), 'wallet'],
    [
      'address in another case',
      event({ walletAddress: ADDRESS.toLowerCase() }),
      order({}),
      'wallet',
    ],
    ['tag on an untagged order', event({ walletTag: '42' }), order({}), 'wallet'],
    ['another tag', event({ walletTag: '43' }), order({ walletTag: '42' }), 'wallet'],
    ['same tag', event({ walletTag: '42' }), order({ walletTag: '42' }), null],
    ['empty tag on an untagged order', event({ walletTag: '' }), order({}), null],
    [
      'empty tag on an order stored with an empty tag',
      event({ walletTag: '' }),
      order({ walletTag: '' }),
      null,
    ],
    ['empty tag on a tagged order', event({ walletTag: '' }), order({ walletTag: '42' }), 'wallet'],
    ['tag omitted on a tagged order', event({}), order({ walletTag: '42' }), null],
  ] as const)('%s', (_name, incoming, stored, expected) => {
    expect(webhookMismatch(stored, incoming)).toBe(expected);
  });

  it('reports the customer before the wallet when both differ', () => {
    expect(
      webhookMismatch(
        order({}),
        event({ externalCustomerId: OTHER_USER_ID, walletAddress: 'rAttackerAddress' }),
      ),
    ).toBe('customer');
  });

  it('flags every address other than the issued one', () => {
    fc.assert(
      fc.property(
        fc.string().filter((address) => address !== ADDRESS),
        (address) => {
          expect(webhookMismatch(order({}), event({ walletAddress: address }))).toBe('wallet');
        },
      ),
    );
  });
});

describe('fillsDeliveryDetails', () => {
  it.each([
    ['nothing reported', order({}), {}, false],
    ['txHash fills an empty txHash', order({}), { txHash: '0xabc' }, true],
    ['gatewayId fills an empty gatewayId', order({}), { gatewayId: 'gw-1' }, true],
    ['cryptoAmount fills an empty cryptoAmount', order({}), { cryptoAmount: '10' }, true],
    ['an empty txHash still counts as reported', order({}), { txHash: '' }, true],
    ['a new txHash over a recorded one', order({ txHash: '0xabc' }), { txHash: '0xdef' }, false],
    [
      'a new cryptoAmount over a recorded one',
      order({ cryptoAmount: '10.00000000' }),
      { cryptoAmount: '99' },
      false,
    ],
    [
      'every detail already recorded',
      order({ txHash: '0xabc', gatewayId: 'gw-1', cryptoAmount: '10.00000000' }),
      { txHash: '0xdef', gatewayId: 'gw-2', cryptoAmount: '99' },
      false,
    ],
    [
      'one missing detail among recorded ones',
      order({ txHash: '0xabc', cryptoAmount: '10.00000000' }),
      { txHash: '0xdef', gatewayId: 'gw-1', cryptoAmount: '99' },
      true,
    ],
    [
      'a detail the order lacks but the event omits',
      order({ txHash: '0xabc' }),
      { txHash: '0xabc' },
      false,
    ],
  ] as const)('%s is %s', (_name, stored, next, expected) => {
    expect(fillsDeliveryDetails(stored, next)).toBe(expected);
  });

  it('never fills when every detail is already recorded, whatever the redelivery says', () => {
    const optional = fc.option(fc.string(), { nil: undefined });
    fc.assert(
      fc.property(optional, optional, optional, (txHash, gatewayId, cryptoAmount) => {
        const next = {
          ...(txHash === undefined ? {} : { txHash }),
          ...(gatewayId === undefined ? {} : { gatewayId }),
          ...(cryptoAmount === undefined ? {} : { cryptoAmount }),
        };
        expect(
          fillsDeliveryDetails(
            order({ txHash: '0xabc', gatewayId: 'gw-1', cryptoAmount: '10.00000000' }),
            next,
          ),
        ).toBe(false);
      }),
    );
  });
});
