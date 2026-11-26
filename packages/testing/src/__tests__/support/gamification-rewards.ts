import { vi } from 'vitest';
import { newGame, startedRound, type Bettor } from './casino.js';
import type { WalletE2e } from './wallet.js';

export async function wager(e2e: WalletE2e, bettor: Bettor, amount: string) {
  const { gameId } = await newGame(e2e);
  await startedRound(bettor, gameId, amount);
}

export async function eventually(assertion: () => Promise<void>, timeout = 15_000) {
  await vi.waitFor(assertion, { timeout, interval: 100 });
}
