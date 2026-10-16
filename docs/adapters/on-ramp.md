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
- **Return an https checkout URL and its expiry.** `createCheckout` answers the vendor's order id,
  an https `checkoutUrl` and `expiresAt`, the ISO timestamp after which the vendor stops taking
  payment on it. Core validates the answer; anything else, a plain-http URL included, fails the
  order and the player gets the vendor-unavailable refusal.
- **Dedupe on the idempotency key.** The checkout call carries one per purchase attempt, already
  scoped to the player. A retry with the same key returns the original order rather than opening a
  second one.
- **Answer options and estimates in the port's shapes.** Core validates `getOptions` against
  `OnRampOptionsSchema` and `getQuotes` against `OnRampQuoteSchema`: decimal-string amounts, a UTC
  ISO `expiresAt`. Malformed options refuse every route as unavailable; malformed estimates do the
  same on the quote route and count as no estimate at checkout.
- **Answer `getStatus` for an order you opened,** and `null` for one you do not know. Core asks
  while an order is still open and the player is looking at it, at most once per order every ten
  seconds when a cache is bound. An answer outside the status set is ignored.
- **Parse a webhook into the event shape, or `null`.** Core validates the parsed event against
  `OnRampWebhookEventSchema` and acknowledges, but ignores, one that fails it, so a malformed event
  is never redelivered forever.
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
   the fiat amount plus the player's still-open orders in that fiat: processing orders of any age,
   pending ones until their checkout expires, and pending ones the vendor has not opened yet for
   fifteen minutes after they are recorded. The check and the order's insert hold one per-player
   lock, so concurrent checkouts count against each other. An order the vendor still reports
   pending past its expiry, a completed one whose coins are not credited yet, and an open order in
   another fiat are not counted; the `rg_limit_breach` finding filed when the deposit is credited
   covers them. The RG and geo gates run before a retried key is replayed. An estimate the vendor
   fails to give does not block the checkout. Options, quote and checkout share one per-player
   throttle, separate from wallet mutations; reading an order has its own.
4. Core records a pending order against a deposit address issued to this player, then asks the
   vendor for a checkout with that order's id. A failure, at the vendor or while recording its
   answer, marks the order failed and is audited with the error's class only. A retry under the
   same idempotency key returns the original checkout.
5. The player pays on the vendor's page. The order's status is readable by its owner only, and is
   refreshed from the vendor while it is still open.
6. The vendor sends status updates; each change is applied to the order and audited. Status only
   moves forward - pending to processing or a terminal status, processing to a terminal status or
   refunded, completed to refunded - judged against the order's status under a row lock, so two
   racing updates cannot drop the later one. Anything else is logged and ignored. A redelivery
   writes nothing unless it adds a tx hash, gateway or crypto amount, which is recorded and
   audited. A verifier that throws is answered like a bad signature.
7. The coins land on-chain and the deposit path credits them.

## Binding a vendor

An overlay plugin in the consumer's repo binds the adapter and, for webhooks, the matching
verifier. Scaffold it with `/scaffold-plugin`, and register it after the wallet module. Core binds
neither.
