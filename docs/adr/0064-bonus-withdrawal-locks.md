# ADR-0064: Bonus withdrawal locks

**Date**: 2026-11-17
**Status**: Accepted

> **Update (2026-11-24)**: An opt-in deposit turnover requirement now sits beside this lock, in [ADR-0065](./0065-deposit-turnover-requirement.md). Its check runs after `onOutflow`, and balance reads show the stricter of the two locks, never their sum.

## Context

ADR-0062 tracks the real money a bonus ties up as two counters over the wallet balance: B, the money
it was matched against, and A, the other money tied to it. Nothing stopped that money leaving. A
withdrawal forfeited every live bonus and paid out, so a player could deposit, play the bonus, and
cash out the matched deposit whenever it suited them. A swap or a gift could also move B into another
currency or to another player, where no grant counts it. Some operators want a withdrawal refused
while a bonus runs. Others want today's forfeit.

## Decision

**A sealed port owned by the bonus module.** `BONUS_FUND_LOCKS` exposes `lockedFunds` and
`onOutflow`. It is sealed beside `BONUS_WAGERING`, so an overlay cannot rebind it to unlock money.
The wallet lists it under `optionalPorts`.

**What locks.** A grant locks when `terms.funds.lockWithdrawals` says so. When the terms leave it
out, only a `deposit` grant locks. Locked money in a currency is `min(real balance, Σ A + B)` over
the player's `active`, unexpired locking grants in that currency. Free money is the rest. A grant
past its `expiresAt` no longer locks, swept or not. Completion, expiry, forfeit
and depletion release the lock with no extra code, because the grant leaves `active`.

**Where it runs.** On the caller's transaction, after the caller's debit, so a refusal rolls the
whole movement back. The lock order matches a bet's: the wallet row FOR UPDATE, then the currency's
balance row, then the grants FOR SHARE in id order. A bet and an outflow serialise on the wallet
row; expiry and admin forfeit lock a single grant and never wait on a wallet row. Locked is computed
from the balance before the debit. The outflow passes when the balance after it still covers the
locked amount.

**What it guards.** A withdrawal follows `promo.bonus.withdrawalWhileActive`:

- `forfeit` (the default) forfeits every live grant on the withdrawal's transaction, exactly as
  before.
- `block` refuses any withdrawal that would dip into locked money and leaves every grant alone.

Every other debit is refused over the free money in both modes: a swap, and any debit type but
bets, losses, admin debits and corrections. A withdrawal debit through the command port
counts as a withdrawal. A new debit type is locked until someone exempts it.

**The refusal.** `BonusFundsLockedError` maps to CONFLICT. Its message is
`promo.bonus.lockedFundsMessage`, with a generic English default. errors.md allows this one
player-facing message. Clients branch on `data.reason`; the [port's contract](../../packages/core/src/contracts/adapters/bonus-fund-locks.ts) lists the fields.

**For consumers.** The optional `WALLET_COMMANDS.movableFunds` returns `{ real, locked, free }`
under the same locks a debit takes, for a transfer to check first. The wallet still enforces the lock on its own debit.

## Consequences

- No migration needed.
- A replayed withdrawal or swap returns its original result before any check runs, even when a
  locking grant appeared after it.
- Approving a queued withdrawal does not re-check the lock.
- `getBalance(s)` and `wallet.activity` add optional `locked` and `free`; a staff funds route always shows them. All read lock-free from the same computation.
- The mode is platform-wide, not per offer.
- Without `BONUS_FUND_LOCKS`, `forfeit` mode falls back to `BONUS_LIFECYCLE.forfeitHeld`, so a custom bonus engine keeps forfeiting.
- Even in the default mode, a swap or gift over locked money now answers 409.
- An operator clawback goes through an admin or correction debit, which the lock never
  checks.
- A process that loads the wallet without the bonus module, a split manifest included, fails its
  boot in `block` mode and locks or forfeits nothing in `forfeit` mode.
