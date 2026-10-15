# On-Ramp Adapter

The seam to a vendor that sells crypto for fiat - card, bank transfer, local payment methods - and
delivers it on-chain to the player's own deposit address. The vendor usually aggregates several
payment gateways and prices each one separately. Core never learns a vendor's name.

Contract: [`packages/core/src/contracts/adapters/on-ramp.ts`](../../packages/core/src/contracts/adapters/on-ramp.ts).
Read it for the exact method names and shapes. This file covers what the port is for and how a
binding has to behave.

## Nothing here moves a balance

An on-ramp order is not a ledger event. The coins arrive on a deposit address the platform issued,
and the ordinary deposit path credits them, with its own holds, minimums and reconciliation. The
vendor's own status updates are recorded in the audit log and nothing else, so a forged or
replayed webhook can never pay anyone. With no binding, every on-ramp route refuses and nothing
else changes.

## What a binding must guarantee

- **Dedupe on the idempotency key.** The checkout call carries one per purchase attempt. A retry
  with the same key returns the original order rather than opening a second one.
- **Treat the quoted crypto amount as binding.** It is what reaches the address, net of every fee.
  The rate is informational and is never multiplied out to reach an amount.
- **Map assets both ways.** Core speaks the asset catalog's currency and network; the adapter
  translates them to the vendor's codes on the way out and back on the way in.
- **Send the vendor nothing about the player but their id.** No email, no name. The vendor runs its
  own KYC on the person paying.
- **Fail closed on an unverified webhook.** The verifier is its own binding, separate from the
  payment one, because the on-ramp vendor signs with its own key. Verify against the raw bytes; a
  missing or wrong signature means reject.
- **Echo the player id back when the vendor can.** A status update names the delivery address and,
  where the vendor supports it, the customer the order was opened for. Core drops an update whose
  address it never issued, or whose address belongs to someone else.

## Purchase flow

1. The player asks what can be bought. Core returns the vendor's fiats and only those of its
   assets the platform takes deposits in.
2. The player asks for quotes. The vendor ranks one per gateway.
3. The player picks a gateway. Before the vendor opens an order, core refuses a player under a
   responsible-gambling restriction, a blocked country, an amount outside the vendor's range, an
   asset the platform does not take deposits in, a gateway the vendor no longer quotes, and a
   purchase over the player's deposit limit. The price is re-quoted on the server, never taken
   from the client, and the delivery address is always one issued to this player.
4. The vendor returns a checkout URL; the player pays there. The order is audited.
5. The vendor sends status updates; each one is audited against the address owner.
6. The coins land on-chain and the deposit path credits them.

## Binding a vendor

An overlay plugin in the consumer's repo binds the adapter and, for webhooks, the matching
verifier. Scaffold it with `/scaffold-plugin`, and register it after the wallet module. Core binds
neither.
