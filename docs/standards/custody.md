# Custody

Read this before changing deposit addresses, the sweep, reconciliation, the asset catalog, or
a custody vendor binding. `docs/standards/money.md` still governs every balance change here.
The port, the topology diagrams and the sweep/reconciliation mechanics live in
`docs/adapters/custody.md`; this file is only the rules the caller must not break.

The player's balance does not exist on any chain. It is a ledger row, and the
address-to-player mapping lives only in this database. It is the sole attribution of an
inbound deposit.

## Attribution

- Key on `(address, network)`, never the address alone. One account-chain address serves every
  token on that chain and repeats across sibling chains, so an address maps to many issued rows.
  A unique index enforces this.
- A tag is optional on the wire, so funds can arrive with no tag or the wrong one. Persist the
  tag with the issued address, and read the **destination** tag on an inbound event.
- Never attribute by amount and time. An unattributable deposit becomes a reconciliation
  finding for an admin to credit by hand. Guessing fabricates money data that was never recorded.
- Credit on the vendor's confirmed event, never on detection, and deduplicate on the vendor's
  settlement id.

## Sweeping

- Never trigger a sweep from a deposit. Crediting the player and moving the funds are
  independent, and a blocked sweep must never delay a credit.
- Policy belongs to the caller, not the adapter: dust floor, a minimum multiple of the current
  network fee, and a fee ceiling that pauses the cycle unless the pool is under its liquidity floor.
- Every transfer carries an idempotency key. A thrown call cannot be told apart from a lost
  response, and the vendor must dedupe the retry rather than move funds twice.
- Record the destination pool reference. It is the evidence that player funds landed in the
  player pool and not an operator account, and a regulator asks for it.
- A sweep is an internal transfer in the ledger. It is never a player transaction and never
  appears in transaction history.
- Player funds and operator funds never share a container.

## Fees and gas

- Moving a token on an account chain needs that chain's native asset in the same container.
  Either top each container up or relay the fee from one funding container - never both on the
  same chain, which funds it twice and strands the surplus.
- Set limits per `(currency, network)`. The same token costs cents on one chain and dollars on
  another, so one currency-wide floor is either too high for the cheap chain or below the fee
  on the expensive one.

## Withdrawals

- Debit inside the transaction that creates the withdrawal row, and refund in full on rejection.
- Register a payout destination with the vendor on the address-book write path, not at payout
  time: approval can need a human quorum, which must not sit inside a withdrawal already
  holding a player's funds. Registration is idempotent on `(userId, currency, network, address)`.
- Auto-approval fails closed. A missing risk or KYC signal goes to manual review.
- Pay from the pool, never from a player's deposit container, and across more than one payout
  container. An account chain serializes on a per-account sequence number and a UTXO chain caps
  how many unconfirmed transactions may chain, so one stuck payout blocks every later one
  sharing its container.
- Once broadcast, cancellation is not guaranteed. Say so on the surface that offers it.

## Reconciliation

- The webhook is a signal, not a guarantee. Deliveries are retried and the retries run out, so
  a ledger with no second source keeps a withdrawal in `processing` forever.
- Findings are surfaced, never auto-credited. Crediting one is an admin action with an actor
  and a reason, and the run and its findings go to the audit log.

## Vendor hygiene

- Verify every webhook and fail closed on a missing header, an unknown key, or a fetch failure.
- Send an idempotency key on every state-changing vendor call and back off on rate limiting.
- Credentials are least-privilege and rotated, and never live in code or a committed env file.
  The credential that initiates a transfer is not the credential that signs it.
- The asset catalog's write path asks the bound adapter whether it can serve a pair, so an
  unknown pair fails in the admin form and not on a player's deposit screen.
