export {
  WalletService,
  WalletNotFoundError,
  InsufficientBalanceError,
  UnsupportedNetworkError,
} from './service/wallet.service.js';
export { createWalletRouter, walletBalanceChannel } from './router/index.js';
export { default } from './plugin.js';
