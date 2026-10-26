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
  "unavailable" refusal. Never put a token, a request body or an unmasked email in it, and do
  not attach a raw HTTP error as its `cause`: it can carry headers and bodies. Any other error
  that escapes the adapter is handled the same way, but core keeps only its class name as the
  reason, so throwing the provider error is what leaves a useful reason in the log.
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
   request path. On a first open the sync rides on an event committed with the link, so a job
   queue outage delays the first context instead of losing it.
4. The sync job writes the context for a linked player. It retries with backoff for about four
   hours, then logs an error and tries once at the top of each hour until a sync lands, so an
   outage does not leave support staff on a stale RG state. Each give-up reaches the bound
   error tracker with the player's user id and the last error. Every give-up for a player in the
   same hour shares one hourly try. Scheduling that try is itself retried once; when the job
   queue refuses it twice, or the process stops before it is scheduled, an error names the
   player and their context waits for their next refresh.
5. Besides every chat open, a linked player's context is refreshed when a self-exclusion starts
   or is lifted, when a cooling-off starts, ends or is lifted, when the account status changes or
   the account is closed or reopened, when the KYC status or rank changes, and when the email
   changes. A player who never opened the chat gets no sync. A username change has no event today,
   so it reaches the vendor on the player's next chat open; the same holds for an active-currency
   change.

## Unbound

Core binds no provider. Without one, the session route answers service-unavailable as not
configured and boot logs one warning. Whether a player is linked is read from the database, not
from the process, so a refresh still enqueues a sync for a player another process linked. A
process without a provider fails that job, logging a warning per attempt, and the queue retries
it, so in a fleet where only some processes have the provider bound the sync lands on one that
has it instead of being dropped. A give-up still schedules the hourly try, whichever process
gives up. With no provider anywhere and no linked player, nothing is enqueued and nothing fails.

To turn the support chat off, remove the module from `extensions.config.ts`, together with any
plugin that depends on it. Keeping the module loaded with no provider bound while players are
still linked is treated as a misconfiguration: each refreshed player keeps getting one try an
hour, and every failed one logs an error, until a provider is bound or the module is removed.

## Binding a vendor

An overlay plugin in the consumer's repo binds the provider. Scaffold it with `/scaffold-plugin`
and register it after the support-chat module.

## Not built yet

Listing a player's vendor chats or tickets for the back office will be a further read method on
this port. An account-manager field in the context and erasing the vendor customer under a
data-rights request wait for those features to land in core.
