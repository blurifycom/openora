import { createToken } from './token.js';

/**
 * One operator-configured (currency, network) pair the platform accepts deposits for or
 * pays withdrawals out of. Rows are editable at runtime from the admin surface, so this
 * is config rather than code: adding a currency is not a deploy.
 */
export type WalletAsset = {
  currency: string;
  network: string;
  /**
   * The bound payment vendor's own identifier for this asset (eg a custody vendor's
   * `USDT_ERC20`). Opaque - the wallet module stores and returns it, never parses it,
   * so a different vendor's identifier scheme needs no core change.
   */
  providerAssetId: string;
  minDeposit: string;
  minWithdrawal: string;
  withdrawalFee: string;
  depositEnabled: boolean;
  withdrawalEnabled: boolean;
};

/**
 * Read side of the asset catalog, for an adapter that needs the operator's asset table
 * without importing wallet internals.
 *
 * Unlike most ports here, the wallet module binds a DB-backed default implementation to
 * this token itself (as with `CACHE`/`RATE_LIMITER`), so an operator gets a working
 * catalog with no wiring; rebinding it is possible but not required.
 */
export type WalletAssetCatalog = {
  list(): Promise<WalletAsset[]>;
  get(currency: string, network: string): Promise<WalletAsset | null>;
};

export const WALLET_ASSET_CATALOG = createToken<WalletAssetCatalog>('WALLET_ASSET_CATALOG');
