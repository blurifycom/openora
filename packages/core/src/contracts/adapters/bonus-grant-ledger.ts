import { createToken, type Token } from './token.js';

export type BonusGrantLedgerReader = {
  ledgerRowsQuery(userId: string): unknown;
};

export const BONUS_GRANT_LEDGER: Token<BonusGrantLedgerReader> = createToken('BONUS_GRANT_LEDGER');
