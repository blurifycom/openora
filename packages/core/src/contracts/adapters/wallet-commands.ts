// Wallet command port. Lets another module move money in the wallet WITHIN its
// own database transaction, without importing wallet's tables - so the two modules
// are decoupled at the code AND data boundary and either can later be extracted to
// its own service. `tx` is the caller's active transaction handle: the debit is
// atomic with whatever else the caller writes in that transaction (eg a sportsbook
// bet insert), so a rollback unwinds both. In-process the default adapter runs on
// the caller's tx and preserves the single-transaction guarantee; a remote wallet
// service binds an implementation that runs a saga/compensation instead - the
// caller is unchanged. Money stays synchronous and transactional, never over
// events. See ADR-0010 / ADR-0016.
import { createToken, type Token } from './token.js';

export type WalletDebitArgs = {
  userId: string;
  amount: number;
};

// Outcome instead of a thrown error, so the caller keeps ownership of its own
// domain error (and its router error mapping) rather than catching a wallet error.
export type WalletDebitOutcome =
  | { ok: true; newBalance: number }
  | { ok: false; available: number };

export type WalletCommands = {
  debit(tx: unknown, args: WalletDebitArgs): Promise<WalletDebitOutcome>;
};

export const WALLET_COMMANDS: Token<WalletCommands> = createToken('WALLET_COMMANDS');
