# ADR-0046: Sportsbook Ledger Port

**Date**: 2026-10-15
**Status**: Accepted

## Context

An operator wants sports betting from a turnkey provider that owns odds, bet acceptance and
settlement and calls the operator's wallet with seamless-wallet callbacks. Core must stay
vendor-neutral: a second provider, or a sportsbook engine the platform runs itself, has to plug
into the same seam without a core change. Every callback moves money and must survive provider
retries. The provider can reverse a settlement after the player has withdrawn the winnings, so a
reversal can find less on the balance than it has to take back.

## Decision

- **The overlay owns the wire, core owns the ledger.** Callback routes, signature checks and the
  provider codec live in the operator's overlay. It calls one core command port,
  `SPORTSBOOK_LEDGER`, with domain operations (reserve, confirm, cancel, settle, reopen). A core
  route per provider was rejected because it puts vendor protocol in core, and settlement over
  events because money never travels over events (ADR-0017).
- **Each port operation owns its transaction.** It is idempotent on the provider's transaction
  id, and the same id with a different request is refused. Unlike `GAMING_COMMANDS`, the port
  takes no caller transaction, so the overlay can neither break the lock order nor hold a lock
  across a network call.
- **The provider is the outcome authority.** The ledger records what the provider settles. An
  admin never types a result or an amount; the one manual correction re-reads the provider's
  status. `GAME_OUTCOME_AUTHORITY` stays for outcomes the platform generates, so that binding it
  here doesn't claim a certification the platform does not hold (ADR-0034).
- **KYC as for casino.** No KYC check at play time; KYC gates withdrawals. A sportsbook-only tier
  would make two products disagree about one player.
- **A reversal never overdraws.** A correction debit collects what the balance holds. The rest
  becomes debt that the sportsbook module owns and recovers from later wins, and a withdrawal hold
  lives exactly as long as that debt. The hold is the wallet's own, placed by the owning module in
  its transaction. The admin-owned `withdrawal_lock` tag was rejected because it cannot be tied
  atomically to the debt row.
- **The ledger is the source of truth for money metrics.** GGR, NGR and RG spend read the wallet
  ledger across products, with a `win_reversal` type for winnings taken back.
- **Sportsbook stakes are real-money only.** They never touch a bonus grant, and rakeback and the
  rank challenge leave sportsbook out until the operator adds it.

## Consequences

- An operator wires one port and one overlay. A second provider changes only the overlay codec.
- GGR and RG spend are cash-basis for a reversed bet: a recovered debt lands in the period it is
  collected, and a written-off debt never reaches the ledger.
- The RG `loss` limit stays unenforced. An open bet's outcome is unknown for days, and reversals
  move the number after the fact.
- RG wager spend now counts every product's stakes, pvp included.
- A custom `WALLET_COMMANDS` binding must implement correction debits and withdrawal holds, and a
  `wallet.balance.changed` subscriber must handle `win_reversal`.
- Bonus money on sports bets would need a later core change.
