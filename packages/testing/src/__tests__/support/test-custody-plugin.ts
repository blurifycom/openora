import { randomUUID } from 'node:crypto';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import {
  PAYMENT_ADAPTER,
  PLATFORM_CONFIG,
  definePlatformConfig,
  type CustodyBalance,
  type PaymentAdapter,
  type PaymentWebhookEvent,
} from '@openora/core/contracts';
import { globalStore } from './global-store.js';
import { parseTestWebhook } from './payment-webhook-event.js';

type SweepCall = { balance: CustodyBalance; idempotencyKey: string };

type CustodyVendor = {
  transactions: PaymentWebhookEvent[];
  sweepable: CustodyBalance[];
  sweeps: SweepCall[];
  listingGate: Promise<void> | null;
};

const VENDOR_STORE = Symbol.for('openora.testing.custody-vendor');
const isCustodyVendor = (value: unknown): value is CustodyVendor =>
  typeof value === 'object' && value !== null && 'transactions' in value && 'sweeps' in value;
const vendor = globalStore(
  VENDOR_STORE,
  isCustodyVendor,
  (): CustodyVendor => ({
    transactions: [],
    sweepable: [],
    sweeps: [],
    listingGate: null,
  }),
);

const NEVER_CRON = '0 0 1 1 *';

export const setVendorTransactions = (events: PaymentWebhookEvent[]) => {
  vendor.transactions = events;
};

export const setSweepableBalances = (balances: CustodyBalance[]) => {
  vendor.sweepable = balances;
};

export const holdSweepListing = () => {
  let release: () => void = () => undefined;
  vendor.listingGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return release;
};

export const sweepsFor = (userId: string) =>
  vendor.sweeps.filter((call) => call.balance.userId === userId);

export const resetCustodyVendor = () => {
  vendor.transactions = [];
  vendor.sweepable = [];
  vendor.sweeps = [];
  vendor.listingGate = null;
};

export default {
  id: 'testing-custody',
  dependsOn: ['wallet', 'identity', 'testing-payment-webhook'],
  register(ctx) {
    ctx.provide(PLATFORM_CONFIG, () =>
      definePlatformConfig({
        registration: { termsVersion: 'test-v1' },
        wallet: {
          reconciliation: { cron: NEVER_CRON, ledgerInvariantCron: NEVER_CRON },
          sweep: { cron: NEVER_CRON },
        },
      }),
    );
    ctx.provide(
      PAYMENT_ADAPTER,
      () =>
        ({
          async processDeposit() {
            return { externalId: `test-${randomUUID()}`, status: 'completed' };
          },
          async processWithdrawal() {
            return { externalId: `test-${randomUUID()}`, status: 'processing' };
          },
          async issueDepositAddress(userId, currency) {
            return { address: `addr-${userId}-${currency}` };
          },
          parseWebhook(rawBody) {
            return parseTestWebhook(rawBody);
          },
          async listTransactions() {
            return vendor.transactions;
          },
          async getWithdrawalStatus() {
            return null;
          },
          async listSweepableBalances() {
            await vendor.listingGate;
            return vendor.sweepable;
          },
          async sweepToPool(balance, { idempotencyKey }) {
            vendor.sweeps.push({ balance, idempotencyKey });
            return { externalId: `sweep-${randomUUID()}`, poolRef: 'test-pool' };
          },
        }) satisfies PaymentAdapter,
    );
  },
} satisfies Plugin<CoreTokenCatalog>;
