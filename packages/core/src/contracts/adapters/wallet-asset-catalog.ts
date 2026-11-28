import { createToken } from './token.js';

export type WalletAsset = {
  currency: string;
  network: string;
  providerAssetId: string;
  minDeposit: string;
  minWithdrawal: string;
  withdrawalFee: string;
  depositEnabled: boolean;
  withdrawalEnabled: boolean;
};

export type WalletAssetCatalog = {
  list(): Promise<WalletAsset[]>;
  get(currency: string, network: string): Promise<WalletAsset | null>;
};

export const WALLET_ASSET_CATALOG = createToken<WalletAssetCatalog>('WALLET_ASSET_CATALOG');
