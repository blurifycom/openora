# Payment Adapter

The seam between the wallet ledger and whoever actually holds or moves the money. Core never
learns a vendor's name; it learns the shape of what a vendor can do.

Contract: [`packages/core/src/contracts/adapters/payment.ts`](../../packages/core/src/contracts/adapters/payment.ts).
Read it for the exact method names and shapes. This file covers what the port is for and how a
binding has to behave. The money rules the caller must follow are in
[`docs/standards/custody.md`](../standards/custody.md); a vendor that holds funds per player also
reads [`custody.md`](./custody.md).

## Two vendor shapes

**A synchronous processor** - card, bank transfer, e-wallet. It takes a charge or a payout and
answers in the same call with a final outcome. The ledger finalises the transaction immediately.
It issues no addresses and sends no webhooks, so it implements only the two money-moving
capabilities.

**An asynchronous, address-issuing vendor** - a crypto custody rail. Deposits are inbound: the
player is handed an address once and sends funds whenever, with no further call to this API. A
payout leaves in a non-final state and settles later. Both directions are confirmed by webhook,
so this shape also issues addresses and normalises the vendor's webhook payloads.

Everything beyond those two - pooling, sweeping, transaction listing, address whitelisting - is
optional. A binding declares what it supports by implementing it; core skips what is absent
rather than failing.

## What a binding must guarantee

- **Fail closed on an unverified webhook.** A missing header, an unknown signing key, or a key
  fetch that failed all mean reject. Never fall through to processing the body.
- **Verify against the raw bytes.** Parsing the body before verifying changes whitespace and key
  order, and the signature will not match.
- **Normalise, never interpret.** The adapter translates a vendor payload into the shared event
  shape. Deciding whether to credit anyone is the ledger's job, not the adapter's.
- **Carry an idempotency key on every state-changing call.** A thrown call and a lost response
  look identical from here, and the retry must not move funds twice.
- **Return the vendor's own settlement identifier.** It is what makes crediting idempotent, and
  what an auditor traces.
- **Say which pairs you serve.** The asset catalog asks the binding whether it can handle a
  currency and network before an operator saves the pair, so an unsupported pair fails in an
  admin form rather than on a player's deposit screen.
- **Do not hold a transaction open across a vendor call.** Network calls belong outside the
  database transaction; persist a recoverable state first.

## Deposit flow, address-based vendor

1. The player asks for a deposit address. Core issues one through the binding on the first ask and
   persists it, so a second ask returns the stored address without another vendor call.
2. The player sends funds on-chain at some later time. Nothing calls this API.
3. The vendor posts a webhook. Core verifies the signature, asks the binding to normalise the
   payload, resolves the address back to a player, and credits the ledger once - deduplicated on
   the vendor's settlement identifier.

A payout runs the same way in reverse: core submits, the vendor answers "accepted, not final", and
a later webhook moves the transaction to its final state. A replayed webhook, or one for a
transaction already finished, does nothing.

## Binding a vendor

An overlay plugin in the consumer's repo binds the adapter, and a matching verifier when the
vendor does not use the default signature scheme. Scaffold it with `/scaffold-plugin`, and
register it after the wallet module so its binding wins.

Core ships a mock binding that settles everything instantly. It exists so local development runs
with no vendor account, and it talks to no real rail. Never let it reach an environment that holds
real money.

Running a fiat processor and a crypto custodian at the same time goes through the provider
registry - see [`custody.md`](./custody.md#running-more-than-one-vendor).
