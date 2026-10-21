# Support-Chat Adapter

The seam to a vendor that runs the player's live-support chat widget. Core decides which vendor
customer a player is and what support staff see about them; the vendor's HTTP calls, field
definitions and widget stay in the adapter. Core never learns a vendor's name.

Contract: [`packages/core/src/contracts/adapters/support-chat.ts`](../../packages/core/src/contracts/adapters/support-chat.ts).
Read it for the exact method names and shapes. This file covers what the port is for and how a
binding has to behave.

## What core sends, and what it never sends

The backend, not the browser, tells the vendor who the chat customer is, so a player cannot pose
as another player to support staff, and one player is one vendor customer on every device. The
session route takes no input: it always answers for the caller's own player.

Next to the chat, support staff see a context core writes server-to-server, so the player cannot
edit it: the player and user ids, username and email, the account status, whether a
self-exclusion or a cooling-off is in force, the KYC status, the rank name and the active wallet
currency, plus when it was read. The account status shows an active self-exclusion as
self-excluded, except that a suspended or closed account keeps its own status; the self-exclusion
flag is set whenever one is active either way. Responsible gambling is read the way compliance
reads it: a self-exclusion binds until it is lifted, even past its end date; a cooling-off ends at
its expiry, even before the sweep marks it expired.

Core never sends a balance, a document, a phone number or a date of birth. The context schema is
strict, so a field reaches the vendor only when it is added to the contract on purpose.

## What a binding must guarantee

- **One vendor customer per customer id.** Asked for a token without a customer id, create a new
  customer and answer its id. Asked with one, answer a token for exactly that customer. Never
  answer with another customer: core refuses such a token as unavailable rather than open a chat
  as someone else.
- **Answer the token in the port's shape.** Core validates it; a missing access token, a
  non-positive lifetime or anything else malformed answers the player as unavailable.
- **Throw the port's provider error on a refusal, an unreachable vendor or an unexpected
  answer,** with a short reason. The reason goes to the log only; the player gets a fixed
  "unavailable" refusal. Never put a token, a request body or an unmasked email in it.
- **Make the context sync idempotent.** The same context may be written more than once, and two
  syncs for one player may run at once. Core re-reads the context after each write and writes
  again when it moved, so the last write converges on the database's latest state; the adapter
  only has to write what it is given.
- **Own the vendor mapping.** Which vendor fields hold the context, their types and definitions,
  and the customer's display name and email are the adapter's. Mask the email in any log line.
- **Keep operator-owned fields in the adapter.** A field only one operator has, such as its own VIP
  flag or a back-office profile link, is added by that operator's adapter, not by core.

## Flow

1. The player opens the chat. Core throttles the call per player, because every call spends the
   operator's vendor quota.
2. A player already linked gets a token for their customer. A player opening the chat for the
   first time gets a new vendor customer, linked to them in the same transaction as its audit
   entry. When two first opens race, the first link wins and every caller gets its customer; the
   loser's vendor customer is left unused. A vendor customer already linked to another player
   fails the open instead of merging two players.
3. Core enqueues a context sync and answers the token at once; vendor writes never sit on the
   request path.
4. The sync job writes the context for a linked player and skips a player who never opened the
   chat. It retries with backoff for about four hours and logs an error when it gives up. Any
   change to the player's responsible-gambling state, account status, KYC status, rank, email or
   profile enqueues it again.

## Unbound

Core binds no provider. Without one, the session route answers service-unavailable as not
configured, the sync job does nothing, and boot logs one warning.

## Binding a vendor

An overlay plugin in the consumer's repo binds the provider. Scaffold it with `/scaffold-plugin`
and register it after the support-chat module.

## Not built yet

Listing a player's vendor chats or tickets for the back office will be a further read method on
this port. An account-manager field in the context and erasing the vendor customer under a
data-rights request wait for those features to land in core.
