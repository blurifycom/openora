# ADR-0029: Money representation standard

**Date**: 2026-07-12
**Status**: Accepted

## Context

An earlier pass renamed every money column/field to integer minor units
(`amountCents`, `balanceCents`, `thresholdCents`) on the "no float money" rule -
correct on the JS-float-precision half of that rule, wrong on the storage/wire
representation for a multi-currency, multi-asset igaming platform:

- **Currency exponents are not uniform.** JPY and KRW have 0 minor-unit digits, most
  fiat has 2, some (BHD, KWD, OMR) has 3. A single `amountCents` column silently
  assumes exponent 2 for every currency - `100` JPY minor units is not 1 JPY.
- **Crypto has no fixed exponent.** BTC needs 8 decimal places, ETH up to 18. "Cents"
  has no meaning for a wei-denominated ERC-20 balance; integer-cents forces either a
  lossy rescale or a per-asset multiplier table bolted onto every money field.
- **JSON numbers are IEEE-754 doubles.** Once a value crosses the wire as `z.number()`
  it is already float-shaped, integer or not - a 2^53+ balance (a real number in a
  low-exponent or heavily-inflated currency) silently loses precision in transit.
- **Precedent**: real ledgers do not use scaled integers either. COBOL core-banking
  systems store money as packed decimal (`PIC S9(13)V99`) - fixed-point decimal, not a
  binary integer. Payment APIs that went the integer-minor-units route (Stripe) did so
  for a fixed, mostly-2-exponent fiat catalog; PayPal and ISO 20022 messages carry
  amounts as decimal strings precisely to survive multi-currency + JSON/XML transport
  without a float or an exponent table.

## Decision

Money is an **exact decimal**, end to end - never a JS `number`, never a scaled integer.

- **Storage**: every money column is Postgres `NUMERIC` via drizzle's `decimal()`
  (`packages/core/src/wallet/schema/index.ts` etc.), never `real`/`float` and never
  `integer` "cents". Precision/scale is set per column (`decimal({ precision: 18, scale: 2 })`
  for the fiat-shaped columns in this codebase today); a future crypto-native column
  can widen `scale` without a representation change.
- **Wire**: money is a decimal **string** + a `currency` (ISO 4217, or the platform's
  crypto ticker) field alongside it. One shared schema owns the shape:
  `MoneyAmountSchema` (`packages/core/src/contracts/schemas/common.ts`) - a non-negative
  decimal-string regex, reused via `.refine`/composition at each call site (eg a
  strictly-positive deposit amount) rather than re-typed. Every money field in a
  contract, event payload, or config value uses this schema, named plainly (`amount`,
  `balance`, `threshold`), never a `*Cents` suffix.
- **Arithmetic**: balance mutations and comparisons run as Postgres numeric SQL
  (`sql\`${wallet.balance} + ${amount}::numeric\``, or a plain `gte`/`lte`against the
string parameter - Postgres does the numeric comparison, not JS). Where a JS-side
comparison against a decimal string is genuinely unavoidable (a coarse heuristic
threshold, a percentage-of-limit display, a re-KYC watermark), it goes through the
one sanctioned conversion point,`moneyToNumber()` (`@openora/core/server`), which
  documents in its own comment that it must never be used for a ledger write.
- Drizzle's `decimal()` (alias of `numeric()`) defaults to string mode - the DB layer
  already returns a string, so no cents-style `x100`/`/100` conversion exists anywhere
  in the codebase.

## Consequences

- A money value round-trips exactly regardless of currency exponent or precision -
  JPY, USD, and an 18-decimal ERC-20 balance all use the same column type and the same
  wire schema.
- No JS float ever touches a balance; the only float-shaped math left is on explicit,
  documented, non-ledger heuristics.
- Slightly more verbose call sites than a bare `number` (a string needs a currency
  companion and, where math is needed, a name'd conversion point) - accepted; it is the
  same shape most core-banking and payment-network wire formats already use.
- Every money-bearing table takes a migration (add the decimal column, drop the old
  integer column) - accepted pre-1.0 per ADR-0027 precedent (no data-preserving
  migration required at this stage).

## Alternatives considered

- **Integer minor units (Stripe-style, the superseded approach)** - simplest when every
  currency has the same exponent and no asset needs more than 2-3 decimal places.
  Rejected here because the platform is multi-currency (variable exponent) and
  multi-asset (crypto, no fixed exponent) - the exact case this style does not cover
  cleanly.
- **JS `number` for money** - rejected outright; IEEE-754 doubles cannot represent
  every decimal value exactly and silently drift on repeated arithmetic.
- **A `Decimal`/`BigNumber` JS type on the wire** - adds a client-side dependency for
  something the wire format (a plain string) and the DB (numeric) already handle;
  YAGNI unless a consumer needs decimal arithmetic in the browser, at which point it
  parses the wire string itself.

## Follow-ups

- If/when a crypto asset needs more than 18 total digits or a different scale than the
  fiat columns share today, widen that column's `precision`/`scale` - no representation
  change.
