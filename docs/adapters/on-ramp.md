# On-Ramp Adapter

The seam to a vendor that sells crypto for fiat - card, bank transfer, local payment methods - and
delivers it on-chain to the player's own deposit address. The vendor usually aggregates several
payment gateways and prices each one separately. Core never learns a vendor's name.

Contract: [`packages/core/src/contracts/adapters/on-ramp.ts`](../../packages/core/src/contracts/adapters/on-ramp.ts).
Read it for the exact method names and shapes. This file covers what the port is for and how a
binding has to behave.

## Nothing here moves a balance

An on-ramp order is not a ledger event. The coins arrive on a deposit address the platform issued,
and the ordinary deposit path credits them, with its own holds, minimums and reconciliation. Core
keeps an order record per checkout and the vendor's status updates move only that record and the
audit log, so a forged or replayed webhook can never pay anyone. With no binding, every on-ramp
route refuses and nothing else changes.

## What a binding must guarantee

- **Hosted checkout only.** The player picks the gateway and payment method on the vendor's page,
  which also fixes the price. Quotes are estimates for display; an empty list is valid and does not
  block a checkout.
- **Echo the purchase id.** `createCheckout` carries core's `purchaseId`. Send it back on every
  status update; core falls back to the vendor's `externalId` when it is missing.
- **Dedupe on the idempotency key.** The checkout call carries one per purchase attempt, already
  scoped to the player. A retry with the same key returns the original order rather than opening a
  second one.
- **Answer `getStatus` for an order you opened,** and `null` for one you do not know. Core asks
  while an order is still open and the player is looking at it.
- **Map assets both ways.** Core speaks the asset catalog's currency and network; the adapter
  translates them to the vendor's codes on the way out and back on the way in.
- **Send the vendor nothing about the player but their id.** No email, no name. The vendor runs its
  own KYC on the person paying.
- **Throw `OnRampVendorUnavailableError` on a timeout, a rate limit or a 5xx,** with the vendor's
  error as `cause`. The client gets the same refusal as an unbound vendor and a fixed message;
  nothing the vendor said reaches it.
- **Fail closed on an unverified webhook.** The verifier is its own binding, separate from the
  payment one, because the on-ramp vendor signs with its own key. Verify against the raw bytes; a
  missing or wrong signature means reject.
- **Echo the customer and the delivery address when the vendor can.** Core drops, and audits as a
  mismatch, an update whose customer or address disagrees with the order it names.

## Purchase flow

1. The player asks what can be bought. Core returns the vendor's fiats with their limits and only
   those of its assets the platform takes deposits in. The answer is cached per country for a
   minute.
2. The player may ask for estimates. They can be empty.
3. The player confirms. Before the vendor is called, core refuses a player under a
   responsible-gambling restriction, a blocked country, an amount outside the vendor's fiat range,
   an asset the platform does not take deposits in, an estimate under the network's deposit
   minimum, and a purchase that would exceed the player's deposit limit. The limit is checked on
   the fiat amount plus the player's still-open orders in that fiat: processing orders of any age
   and pending ones under 30 minutes old. Every on-ramp route has its own per-player throttle,
   separate from wallet mutations.
4. Core records a pending order against a deposit address issued to this player, then asks the
   vendor for a checkout with that order's id. A failure marks the order failed. A retry under the
   same idempotency key returns the original checkout.
5. The player pays on the vendor's page. The order's status is readable by its owner only, and is
   refreshed from the vendor while it is still open.
6. The vendor sends status updates; each change is applied to the order and audited. A
   redelivery writes nothing.
7. The coins land on-chain and the deposit path credits them.

## Binding a vendor

An overlay plugin in the consumer's repo binds the adapter and, for webhooks, the matching
verifier. Scaffold it with `/scaffold-plugin`, and register it after the wallet module. Core binds
neither.
