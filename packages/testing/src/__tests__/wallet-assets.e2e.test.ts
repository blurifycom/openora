import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '@openora/core/server';
import { PublicWalletAssetSchema, WalletAssetSchema } from '@openora/core/wallet/contract';
import { walletAsset } from '@openora/core/wallet/schema';
import { registerAndMaterializePlayer } from '../index.js';
import {
  addAsset,
  balanceOf,
  bootWalletE2e,
  closeWalletE2e,
  deliverWebhook,
  NETWORK,
  newDepositScenario,
  postWithdrawal,
  type WalletE2e,
} from './support/wallet.js';

let e2e: WalletE2e;

beforeAll(async () => {
  e2e = await bootWalletE2e([
    {
      id: 'testing-withdrawal-adapter',
      path: fileURLToPath(new URL('./support/test-withdrawal-adapter-plugin.ts', import.meta.url)),
    },
  ]);
}, 60_000);

afterAll(() => closeWalletE2e(e2e));

const db = () => e2e.app.container.get(DRIZZLE).db;
const uniqueCurrency = () =>
  Array.from(randomBytes(8), (byte) => String.fromCharCode(65 + (byte % 26))).join('');
const UNSUPPORTED_NETWORK = 'NOSUPPORT';

const assetInput = (currency: string, overrides: Record<string, unknown> = {}) => ({
  currency,
  network: NETWORK,
  minDeposit: '10',
  providerAssetId: `${currency}-${NETWORK}`,
  minWithdrawal: '2',
  withdrawalFee: '0.5',
  ...overrides,
});

const publicAssetsFor = async (currency: string) => {
  const res = await e2e.app.app.request('/wallet/assets');
  expect(res.status).toBe(200);
  const body = (await res.json()) as unknown;
  return PublicWalletAssetSchema.array()
    .parse(body)
    .filter((asset) => asset.currency === currency);
};

const rowsFor = (currency: string) =>
  db().select().from(walletAsset).where(eq(walletAsset.currency, currency));

const codeOf = (body: unknown) =>
  typeof body === 'object' &&
  body !== null &&
  'data' in body &&
  typeof body.data === 'object' &&
  body.data !== null &&
  'code' in body.data
    ? body.data.code
    : undefined;

describe('admin wallet asset catalog', () => {
  it('an admin creating an asset for a currency and network makes it appear in the public enabled list', async () => {
    const currency = uniqueCurrency();
    expect(await publicAssetsFor(currency)).toEqual([]);

    const res = await e2e.admin.post('/wallet/admin/assets', assetInput(currency));

    expect(res.status).toBe(200);
    expect(WalletAssetSchema.parse(await res.json())).toEqual(
      expect.objectContaining({
        currency,
        network: NETWORK,
        depositEnabled: true,
        withdrawalEnabled: true,
      }),
    );
    expect(await publicAssetsFor(currency)).toEqual([
      {
        currency,
        network: NETWORK,
        minDeposit: '10.000000000000000000',
        minWithdrawal: '2.000000000000000000',
        withdrawalFee: '0.500000000000000000',
        depositEnabled: true,
        withdrawalEnabled: true,
      },
    ]);
  });

  it('an admin updating minimums, fee and deposit or withdrawal switches changes what players are allowed', async () => {
    const player = await newDepositScenario(e2e);
    const funded = await deliverWebhook(e2e, player.deposit({ amount: '100' }));
    expect(funded.status).toBe(200);
    const withdraw = (amount: string) =>
      postWithdrawal(player.client, player, { amount, destinationAddress: undefined });

    const before = await withdraw('1');
    const updated = await e2e.admin.put(`/wallet/admin/assets/${player.currency}/${NETWORK}`, {
      minWithdrawal: '20',
      withdrawalFee: '3',
      minDeposit: '50',
    });
    const belowNewMinimum = await withdraw('15');
    const aboveNewMinimum = await withdraw('25');
    const belowNewMinDeposit = await deliverWebhook(e2e, player.deposit({ amount: '20' }));
    const switchedOff = await e2e.admin.put(`/wallet/admin/assets/${player.currency}/${NETWORK}`, {
      withdrawalEnabled: false,
    });
    const afterSwitch = await withdraw('25');

    expect(before.status).toBe(200);
    expect(updated.status).toBe(200);
    expect(WalletAssetSchema.parse(await updated.json())).toEqual(
      expect.objectContaining({
        minWithdrawal: '20.000000000000000000',
        withdrawalFee: '3.000000000000000000',
        minDeposit: '50.000000000000000000',
      }),
    );
    expect(belowNewMinimum.status).toBe(400);
    expect(aboveNewMinimum.status).toBe(200);
    expect(belowNewMinDeposit.status).toBe(200);
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe('74.000000000000000000');
    expect(switchedOff.status).toBe(200);
    expect(afterSwitch.status).toBe(409);
    expect(await publicAssetsFor(player.currency)).toEqual([
      expect.objectContaining({ depositEnabled: true, withdrawalEnabled: false }),
    ]);
  });

  it('a switched-off asset does not appear in the public enabled list', async () => {
    const currency = uniqueCurrency();
    await addAsset(e2e.admin, currency, NETWORK);
    expect(await publicAssetsFor(currency)).toHaveLength(1);

    const off = await e2e.admin.put(`/wallet/admin/assets/${currency}/${NETWORK}`, {
      depositEnabled: false,
      withdrawalEnabled: false,
    });

    expect(off.status).toBe(200);
    expect(await publicAssetsFor(currency)).toEqual([]);
    expect(await rowsFor(currency)).toHaveLength(1);
  });

  it('creating the same currency and network twice is refused as already existing', async () => {
    const currency = uniqueCurrency();
    const first = await e2e.admin.post('/wallet/admin/assets', assetInput(currency));
    const second = await e2e.admin.post(
      '/wallet/admin/assets',
      assetInput(currency, { minDeposit: '99' }),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual(expect.objectContaining({ code: 'CONFLICT' }));
    const rows = await rowsFor(currency);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.minDeposit).toBe('10.000000000000000000');
  });

  it('creating an asset for an unsupported network or unknown provider is refused', async () => {
    const unsupported = uniqueCurrency();
    const unknownProvider = uniqueCurrency();

    const badNetwork = await e2e.admin.post(
      '/wallet/admin/assets',
      assetInput(unsupported, { network: UNSUPPORTED_NETWORK }),
    );
    const badProvider = await e2e.admin.post(
      '/wallet/admin/assets',
      assetInput(unknownProvider, { providerName: 'no-such-provider' }),
    );

    expect(badNetwork.status).toBe(409);
    expect(badProvider.status).toBe(409);
    expect(await rowsFor(unsupported)).toEqual([]);
    expect(await rowsFor(unknownProvider)).toEqual([]);
  });

  it('deleting an asset with issued deposit addresses, in-flight transactions or in use is refused', async () => {
    const player = await newDepositScenario(e2e);
    expect((await deliverWebhook(e2e, player.deposit({ amount: '30' }))).status).toBe(200);
    const addNetwork = async (network: string) => {
      const res = await e2e.admin.post(
        '/wallet/admin/assets',
        assetInput(player.currency, { network, providerAssetId: `${player.currency}-${network}` }),
      );
      expect(res.status).toBe(200);
    };
    await addNetwork('SECONDCHAIN');
    await addNetwork('THIRDCHAIN');

    const heldDelete = await e2e.admin.del(`/wallet/admin/assets/${player.currency}/THIRDCHAIN`);
    const payout = await postWithdrawal(player.client, player, {
      amount: '30',
      network: 'SECONDCHAIN',
      destinationAddress: undefined,
    });
    expect(payout.status).toBe(200);
    const inFlightDelete = await e2e.admin.del(
      `/wallet/admin/assets/${player.currency}/SECONDCHAIN`,
    );
    const addressedDelete = await e2e.admin.del(
      `/wallet/admin/assets/${player.currency}/${NETWORK}`,
    );

    const clean = uniqueCurrency();
    await addAsset(e2e.admin, clean, NETWORK);
    const cleanDelete = await e2e.admin.del(`/wallet/admin/assets/${clean}/${NETWORK}`);

    expect(heldDelete.status).toBe(409);
    expect(codeOf(await heldDelete.json())).toBe('WALLET_ASSET_BALANCE_HELD');
    expect(inFlightDelete.status).toBe(409);
    expect(codeOf(await inFlightDelete.json())).toBe('WALLET_ASSET_TRANSACTION_IN_FLIGHT');
    expect(addressedDelete.status).toBe(409);
    expect(codeOf(await addressedDelete.json())).toBe('WALLET_ASSET_ADDRESS_ISSUED');
    expect(await rowsFor(player.currency)).toHaveLength(3);
    expect(cleanDelete.status).toBe(200);
    expect(await cleanDelete.json()).toBe(true);
    expect(await rowsFor(clean)).toEqual([]);
  });

  it('a non-admin creating, updating or deleting an asset is refused with 403', async () => {
    const player = await registerAndMaterializePlayer(e2e.app, {
      email: `asset-${randomBytes(6).toString('hex')}@e2e.test`,
    });
    const existing = uniqueCurrency();
    await addAsset(e2e.admin, existing, NETWORK);
    const created = uniqueCurrency();

    const create = await player.client.post('/wallet/admin/assets', assetInput(created));
    const update = await player.client.put(`/wallet/admin/assets/${existing}/${NETWORK}`, {
      minWithdrawal: '99',
    });
    const remove = await player.client.del(`/wallet/admin/assets/${existing}/${NETWORK}`);

    expect(create.status).toBe(403);
    expect(update.status).toBe(403);
    expect(remove.status).toBe(403);
    expect(await rowsFor(created)).toEqual([]);
    const [row] = await rowsFor(existing);
    expect(row?.minWithdrawal).toBe('1.000000000000000000');
  });

  it('an unauthenticated caller listing the public assets still sees only enabled assets without admin fields', async () => {
    const enabled = uniqueCurrency();
    const disabled = uniqueCurrency();
    await addAsset(e2e.admin, enabled, NETWORK);
    await addAsset(e2e.admin, disabled, NETWORK);
    await e2e.admin.put(`/wallet/admin/assets/${disabled}/${NETWORK}`, {
      depositEnabled: false,
      withdrawalEnabled: false,
    });

    const res = await e2e.app.app.request('/wallet/assets');
    const body = (await res.json()) as unknown;

    expect(res.status).toBe(200);
    const listed = PublicWalletAssetSchema.array().parse(body);
    expect(listed.some((asset) => asset.currency === enabled)).toBe(true);
    expect(listed.some((asset) => asset.currency === disabled)).toBe(false);
    expect(Array.isArray(body)).toBe(true);
    for (const entry of body as object[]) {
      expect(Object.keys(entry).sort()).toEqual(
        [
          'currency',
          'depositEnabled',
          'minDeposit',
          'minWithdrawal',
          'network',
          'withdrawalEnabled',
          'withdrawalFee',
        ].sort(),
      );
    }
  });
});
