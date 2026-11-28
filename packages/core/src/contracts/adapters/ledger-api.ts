import type {
  LedgerV1BalanceArgs,
  LedgerV1BalanceOutcome,
  LedgerV1BetArgs,
  LedgerV1CloseRoundArgs,
  LedgerV1CloseRoundOutcome,
  LedgerV1MoveOutcome,
  LedgerV1ReverseArgs,
  LedgerV1WinArgs,
} from '../schemas/ledger.js';
import type { SportsbookLedger } from './sportsbook-ledger.js';
import { createToken, type Token } from './token.js';

export type LedgerApiV1 = {
  bet(args: LedgerV1BetArgs): Promise<LedgerV1MoveOutcome>;
  win(args: LedgerV1WinArgs): Promise<LedgerV1MoveOutcome>;
  reverse(args: LedgerV1ReverseArgs): Promise<LedgerV1MoveOutcome>;
  closeRound(args: LedgerV1CloseRoundArgs): Promise<LedgerV1CloseRoundOutcome>;
  balance(args: LedgerV1BalanceArgs): Promise<LedgerV1BalanceOutcome>;
  sportsbook: Pick<SportsbookLedger, 'reserve' | 'confirm' | 'cancel' | 'settle' | 'reopen'>;
};

export const LEDGER_API_V1: Token<LedgerApiV1> = createToken('LEDGER_API_V1');
