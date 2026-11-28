import type {
  SportsbookBetStatus,
  SportsbookCancelArgs,
  SportsbookConfirmArgs,
  SportsbookRefusalReason,
  SportsbookReopenArgs,
  SportsbookReserveArgs,
  SportsbookSessionArgs,
  SportsbookSettleArgs,
} from '../schemas/sportsbook.js';
import type { PlayRefusal } from './play-eligibility.js';
import { createToken, type Token } from './token.js';

export type SportsbookLedgerApplied = {
  status: 'applied' | 'replayed';
  betId: string | null;
  betStatus: SportsbookBetStatus | null;
  betVersion: number | null;
  balance: string | null;
  currency: string | null;
};

export type SportsbookLedgerRefused = {
  status: 'refused';
  reason: SportsbookRefusalReason;
};

export type SportsbookLedgerOutcome = SportsbookLedgerApplied | SportsbookLedgerRefused;

export type SportsbookSessionOutcome =
  | {
      status: 'ok';
      userId: string;
      currency: string;
      countryCode: string;
      expiresAt: string;
      balance: string;
      browseOnly: boolean;
    }
  | { status: 'refused'; reason: 'session_invalid' | PlayRefusal };

export type SportsbookLedger = {
  session(args: SportsbookSessionArgs): Promise<SportsbookSessionOutcome>;
  reserve(args: SportsbookReserveArgs): Promise<SportsbookLedgerOutcome>;
  confirm(args: SportsbookConfirmArgs): Promise<SportsbookLedgerOutcome>;
  cancel(args: SportsbookCancelArgs): Promise<SportsbookLedgerOutcome>;
  settle(args: SportsbookSettleArgs): Promise<SportsbookLedgerOutcome>;
  reopen(args: SportsbookReopenArgs): Promise<SportsbookLedgerOutcome>;
};

export const SPORTSBOOK_LEDGER: Token<SportsbookLedger> = createToken('SPORTSBOOK_LEDGER');
