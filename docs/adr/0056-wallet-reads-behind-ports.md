# ADR-0056: Wallet reads behind ports

**Date**: 2026-11-13
**Status**: Accepted. Narrows the read-only `/schema` exception of [ADR-0015](./0015-boundary-lint-custom-oxlint-plugin.md) for the wallet: no production module outside it reads its tables any more, analytics excepted.

## Context

ADR-0054 and ADR-0055 moved the stake gates into the ledger so the wallet can run without identity
or compliance in its process. The reads went the other way too: compliance, player management and
sportsbook each read `wallet` and `wallet_transaction` directly through `@openora/core/wallet/schema`.
A process that loads any of them still needs the wallet's tables in its own database, so the
wallet cannot move behind a service boundary while they do.

## Decision

**Every such read moves to a `WALLET_READER` method that returns what the old query returned.**
The wallet binds the port with `WalletReaderService`. The new methods:

- `getDepositsByCurrency(userId, tx?)`: completed deposits, one unpriced total per currency.
  It replaces three copies of one query: the KYC withdrawal gate
  (`compliance/adapters/kyc-withdrawal-gate.ts`), KYC re-verification on deposit
  (`KycVerificationService.handleDeposit`) and the player's stored total
  (`PlayerService.refreshTotalDeposits`, on its advisory-lock transaction). Each caller keeps its own
  pricing: the gate prices into the withdrawal's pivot, re-verification names the currencies it
  could not price, and the player total prices into the player's currency. `getLifetimeDeposit`
  now prices the same rows, so there is one deposits query.
- `getMoneyByWindow(userId, windowStarts, tx?)`: deposits, stakes and wins per currency per
  window, moved from `compliance/service/rg-standing.service.ts` unchanged. `RgStandingReaderService`
  passes its `repeatable read, read only` transaction, so the money and the compliance facts still
  come from one snapshot.
- `hasWallet(userId, tx?)`: the sportsbook reserve check that a later credit has somewhere to land.
- `sumProviderTransactions(query, tx?)`: what a sportsbook debt collection already took,
  read under the debt row lock.

A real-Postgres parity test (`wallet/__tests__/wallet-reader-parity.int.test.ts`) keeps each old
query verbatim as its oracle, on the pool and on a caller's transaction with uncommitted rows.

**The new methods are required, not optional.** The older optional methods are optional so an
external reader written before them still satisfies the port. These back RG and KYC controls, and a
missing one must fail the typecheck rather than let a caller fall back to a weaker answer. No
implementation outside the wallet binds the port today.

**Transactions.** A method that takes `tx` reads on it; without it, the method reads on a pool
connection of its own and must not be called while the caller holds a transaction. The KYC gate and
re-verification call without one; every other caller passes its own.

**Sportsbook reads through `WALLET_READER`, not `LEDGER_API_V1`.** Sportsbook stays in the ledger
service. The Ledger API is the versioned edge for games and outside callers, and an internal read
would widen that contract. Both reads need the caller's transaction: the reserve check runs inside
the reserve, and the collection sum runs under the debt row's `FOR UPDATE` lock and must see a
collection made earlier in that transaction. The suffix is matched literally now (`escapeLike`);
a shortfall id is a UUID, so nothing it matched before changes.

**Every consumer fails closed when the reader throws.**

- RG standing: `getStanding` rejects. It never answers zero totals or no money.
- RG evaluation reads spend through `RG_LIMIT_LEDGER.spendFor` (ADR-0055), not this port. A failed
  read rejects `evaluateUser`, the job retries, and no flag is raised or cleared on that run.
- KYC withdrawal gate: `requiresKycForWithdrawal` rejects. At request time the wallet refuses the
  withdrawal before any debit; in auto-approval the wallet catches it and leaves the withdrawal for
  a human.
- KYC re-verification: `handleDeposit` rejects, so the deposit event is redelivered (dead-lettered
  after the retry budget, ADR-0045). No watermark or status is written.
- Player total: `refreshTotalDeposits` rejects, its job retries, and the stored `total_deposits`
  stays. The player views read that column, so they show the last good total, never a zero.

**What stays.** `LOSS_LEGS` and `WAGER_LEGS` stay in `wallet/schema`: only the wallet uses them
now. `@openora/core/wallet/schema` stays exported for analytics (ADR-0033) and test seeding.
Analytics' reads move separately.

## Consequences

- Compliance, player management and sportsbook import no wallet table. Compliance and player
  management declare `WALLET_READER` in `requiresPorts`; sportsbook already required it.
- The only implementation is in process. A remote reader lands with the service split and must
  answer each method with the same results. It cannot join the caller's transaction: the RG
  standing loses its single snapshot, and the sportsbook reads lose read-your-writes, so sportsbook
  must stay in the ledger's process.
- A remote reader that is down fails the paths above closed: withdrawals that need the KYC check
  are refused or held, RG evaluation and re-verification retry, and the standing does not load.
- A new consumer of wallet money adds a reader method and a parity case, not a `/schema` import.
