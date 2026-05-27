import { createFileRoute } from '@tanstack/react-router';
import { PlayerWalletPage } from '@oss/react-sdk';

// Wallet has no server fetcher - the wallet module identifies the player by the
// `x-user-id` header the page sets client-side. Render client-only.
export const Route = createFileRoute('/wallet')({
  component: PlayerWalletPage,
});
