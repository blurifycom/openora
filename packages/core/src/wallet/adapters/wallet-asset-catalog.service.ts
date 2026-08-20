import { DrizzleService } from '@openora/core/server';
import { type WalletAsset, type WalletAssetCatalog } from '@openora/core/contracts';
import { and, asc, eq } from 'drizzle-orm';
import { walletAsset } from '../schema/index.js';

const ASSET_COLUMNS = {
  currency: walletAsset.currency,
  network: walletAsset.network,
  providerAssetId: walletAsset.providerAssetId,
  minDeposit: walletAsset.minDeposit,
  minWithdrawal: walletAsset.minWithdrawal,
  withdrawalFee: walletAsset.withdrawalFee,
  depositEnabled: walletAsset.depositEnabled,
  withdrawalEnabled: walletAsset.withdrawalEnabled,
};

/**
 * Default DB-backed catalog, bound by the wallet plugin. Reads every row, enabled or not:
 * a payment adapter resolving an in-flight transaction still needs the asset it was
 * created with.
 */
export class WalletAssetCatalogService implements WalletAssetCatalog {
  constructor(private readonly drizzle: DrizzleService) {}

  list(): Promise<WalletAsset[]> {
    return this.drizzle.db
      .select(ASSET_COLUMNS)
      .from(walletAsset)
      .orderBy(asc(walletAsset.currency), asc(walletAsset.network));
  }

  async get(currency: string, network: string): Promise<WalletAsset | null> {
    const [row] = await this.drizzle.db
      .select(ASSET_COLUMNS)
      .from(walletAsset)
      .where(and(eq(walletAsset.currency, currency), eq(walletAsset.network, network)));
    return row ?? null;
  }
}
